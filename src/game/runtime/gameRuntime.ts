// T41 — GameRuntime: the single authority that stitches the Wave-1 lanes into one runnable sim.
// It owns the IdFactory, FixedClock, SystemScheduler, the SoA zombie store, the collision spatial hash,
// the shared flow-field cache, the destructible wall, combat, and a persistence adapter. It resolves
// the slot<->EntityId seam (lane-S left this to the integrator), wires StructuralHooks so a breach opens
// LOCAL nav only (V5), supplies per-frame tier inputs, and publishes ONLY throttled view snapshots to
// Zustand (V1/V11) — it NEVER writes per-frame world arrays into a store.

import {
  FixedClock,
  IdFactory,
  RingQueue,
  SystemScheduler,
  type EntityId,
  type EventId,
  type SystemContext,
  type VisualEvent,
  type WorldEvent,
  type AnatomyRegion,
  type Command,
  type CommandResult,
} from '@/game/core';
import { StimulusField } from '@/game/stimulus';
import { AudioSim } from '@/game/audio';
import {
  SimulationZombies,
  TierManager,
  SimTier,
  type ZombieSlot,
} from '@/game/simulation';
import { CorpseSystem, resolveCorpseSettings, buildArchetypeRegistry, type ArchetypeRegistry } from '@/game/zombie';
import { SurvivalSystem } from '@/game/player';
import { FlowFieldCache } from '@/game/navigation';
import { CollisionLayer, layerMask, SpatialHash } from '@/game/navigation/collision';
import { HordeSimulation, planarDistanceToPlayer } from './hordeSystems';
import { type StructuralHooks } from '@/game/destruction';
import { ObjectiveSystem, resolveObjectiveSettings } from '@/game/objective';
import {
  DistrictModel,
  HordeEvent,
  resolveHordeEventSettings,
  routeStatesFromModule,
  type SectorDescriptor,
  type HordeEventResult,
} from '@/game/world';
import {
  type PartitionKey,
  type PersistenceAdapter,
} from '@/game/persistence';
import { RuntimePersistence } from './runtimePersistence';
import { InventorySystem, buildDefaultCatalog, ITEM, rollLoot } from '@/game/inventory';
import type { CommandId, ContainerRef, ItemId } from '@/game/core/contracts';
import type { ContainerView } from '@/stores/inventoryView';
import { resolveDomain } from '@/config/registry';
import { weaponsConfig } from '@/config/domains/weapons';
import { combatConfig } from '@/config/domains/combat';
import { playerConfig } from '@/config/domains/player';
import { perceptionConfig } from '@/config/domains/perception';
import { collisionConfig } from '@/config/domains/collision';
import { gameConfig } from '@/config/domains/game';
import { timeConfig } from '@/config/domains/time';
import { audioConfig } from '@/config/domains/audio';
import { weatherConfig, weatherSeverity, type WeatherProfile } from '@/config/domains/weather';
import type { QualityTier } from '@/config/types';
import { CombatSystem, type ShotResult } from '@/game/combat';
import {
  buildTestBlock,
  isWalkableRadius,
  segmentCrossesWall,
  lootableContainerCells,
  DoorSystem,
  WindowSystem,
  windowPlacements,
  resolveHouseVariation,
  REGION_ROOM_A,
  REGION_ROOM_B,
  type TestBlock,
  type Vec3,
  type DoorView,
  type WindowView,
  type FurnitureKind,
} from '@/game/scene';
import {
  nearestInteractable,
  interactionPrompt,
  highlightBoxFor,
  type InteractionTargetWorld,
  type InteractionPrompt,
  type InteractionHighlightTarget,
  type HighlightDims,
} from '@/game/interaction';
import { structuresConfig } from '@/config/domains/structures';
import { worldConfig } from '@/config/domains/world';
import {
  type PopulationEntry,
} from './saveRecord';
import {
  createPlayerSnapshotGate,
  createHordeSnapshotGate,
  createMissionSnapshotGate,
  playerViewStore,
  mapViewStore,
  sessionStore,
  type PlayerViewStore,
  type MapViewStore,
  type SessionStore,
} from '@/stores';
import type { Now } from '@/stores';

const REFERENCE_TIER: QualityTier = 'desktop-high';
/** Synthetic entity id for world loot containers — a high fixed space that never collides with minted
 *  entity ids, so seeding world loot does not perturb the IdFactory counters (determinism/replay, V26). */
const WORLD_CONTAINER_ENTITY = 0x7fff_0001;
/** Friendly display labels for the container-bearing furniture kinds (P1d) — the base name a unique per-piece
 *  loot-container label is derived from (deduped with a count suffix). Only the kinds furnishRoom ever marks as
 *  containers appear here; a missing kind falls back to its raw kind string. */
const FURNITURE_CONTAINER_LABEL: Partial<Record<FurnitureKind, string>> = {
  fridge: 'Fridge',
  dresser: 'Dresser',
  wardrobe: 'Wardrobe',
  bookshelf: 'Bookshelf',
  sideboard: 'Sideboard',
  medicineCabinet: 'Medicine Cabinet',
  shelving: 'Shelving',
  washer: 'Washer',
};
const HORDE_NAV_GROUP = 0;
const ZOMBIE_AGENT_LAYERS = layerMask(CollisionLayer.Movement, CollisionLayer.Projectile, CollisionLayer.Sight);
/** Movement-layer mask for the window-attrition proximity query (T108) — "is a body up against this window". */
const MOVEMENT_LAYER = layerMask(CollisionLayer.Movement);
const MAX_SPAWN_RESAMPLES = 32;
/** Scheduler cadence (ticks) for the T108 window-attrition step — the interval count is fed to the system
 *  tick so the break-board / smash-glass thresholds are counted in real ticks (matches perception cadence). */
const WINDOW_ATTRITION_TICKS = 4;
/** Scheduler cadence (ticks) for the district streaming + objective maintenance step. Structural, like
 *  the interval buckets the horde systems use (every 4 ticks) — not tunable content, so inlined. */
const DISTRICT_STEP_TICKS = 15;

/** Deterministic PRNG so the initial scatter replays identically (V26). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GameRuntimeOptions {
  readonly tier?: QualityTier;
  readonly scene?: TestBlock;
  readonly adapter: PersistenceAdapter;
  readonly partition?: PartitionKey;
  /** Stores to publish snapshots into. Default = the app singletons the HUD reads (V1). */
  readonly playerStore?: PlayerViewStore;
  readonly mapStore?: MapViewStore;
  /** Session store whose lifecycle phase is set to 'dead' on player death (game-over). Default singleton. */
  readonly sessionStore?: SessionStore;
  /** Deterministic scatter seed for the initial horde spawn (V26). */
  readonly scatterSeed?: number;
  /** M2 district streaming sectors (T40). When present, the runtime streams abstract sector populations
   *  in/out as the player traverses (V13). Absent = single-block M1 behaviour (no streaming). */
  readonly sectors?: readonly SectorDescriptor[];
}

export interface DrainedEvents {
  readonly world: WorldEvent[];
  readonly visual: VisualEvent[];
}

export class GameRuntime {
  readonly tier: QualityTier;
  readonly scene: TestBlock;
  readonly clock: FixedClock;
  readonly scheduler = new SystemScheduler();
  readonly ids: IdFactory;
  readonly zombies: SimulationZombies;
  readonly spatial: SpatialHash;
  readonly flowCache: FlowFieldCache;
  readonly tierManager: TierManager;
  readonly combat: CombatSystem;
  /** B9/T54: persistent corpses left by killed zombies (a death leaves a lingering body, not a vanish). */
  readonly corpses: CorpseSystem;
  readonly playerEntity: EntityId;
  /** Shared stimulus field + audio model — firing emits a sound the horde perceives (sound attraction). */
  readonly stimulus: StimulusField;
  readonly audio: AudioSim;
  /** The per-tick horde systems (steering/sound/perception/tiers) — runtime delegates, owns no step logic. */
  private readonly horde: HordeSimulation;
  /** Save/load orchestration (V9/V23/V26) — runtime delegates save()/loadFrom() here, owns no I/O flow. */
  private readonly persistence: RuntimePersistence;
  /** Real container inventory (T23/T85): the player's pack + lootable world containers (T84 loot). */
  readonly inventory: InventorySystem;
  /** Display-name -> ContainerRef for the named containers the inventory UI surfaces. */
  private readonly namedContainers = new Map<string, ContainerRef>();
  /** FIXED world positions of the lootable world containers (the kitchen cupboard) — anchored at a stable
   *  scene cell (NOT the player cell), so a container is interactable only within reach of THAT spot (V4). */
  private readonly worldContainers: { readonly x: number; readonly z: number; readonly label: string }[] = [];
  /** M2 medium-term objective state machine (find parts -> repair radio -> evacuate). */
  readonly objective: ObjectiveSystem;
  /** M2 decisive horde event shaped by the player's structural mods (§G central promise). */
  readonly hordeEvent: HordeEvent;
  /** M2 district streaming model — null in single-block (M1) mode. */
  readonly district: DistrictModel | null;

  private readonly adapter: PersistenceAdapter;
  private readonly partition: PartitionKey;
  private readonly worldEvents: RingQueue<WorldEvent>;
  private readonly visualEvents: RingQueue<VisualEvent>;
  private readonly weapons = resolveDomain(weaponsConfig, REFERENCE_TIER);
  private readonly combatCfg = resolveDomain(combatConfig, REFERENCE_TIER);
  private readonly playerCfg = resolveDomain(playerConfig, REFERENCE_TIER);
  private readonly perception = resolveDomain(perceptionConfig, REFERENCE_TIER);
  private readonly collision = resolveDomain(collisionConfig, REFERENCE_TIER);
  private readonly audioCfg = resolveDomain(audioConfig, REFERENCE_TIER);
  private readonly weatherCfg = resolveDomain(weatherConfig, REFERENCE_TIER);

  private readonly slotToEntity = new Map<ZombieSlot, EntityId>();
  private readonly entityToSlot = new Map<EntityId, ZombieSlot>();
  private readonly lastDamageTick = new Map<ZombieSlot, number>();
  /** Tick of each slot's last melee swing at the player (attack-cooldown gate); cleared on despawn (V26). */
  private readonly lastAttackTick = new Map<ZombieSlot, number>();
  /** Slots spawned by district streaming, tagged by sector so eviction despawns exactly those (V13). */
  private readonly slotToSector = new Map<ZombieSlot, number>();
  /** Structural cells currently on fire (a horde-event lever — fire reroutes/stalls the mass). */
  private readonly burningRoutes = new Set<number>();
  /** Reference horde mass for the event's pressure normalization (the district's starting total). */
  private readonly referenceHordeSize: number;
  private readonly pendingShots: { origin: Vec3; dirX: number; dirZ: number; region: AnatomyRegion }[] = [];
  private targetSlot: ZombieSlot = -1;

  private readonly rand: () => number;
  private readonly structuralHooks: StructuralHooks;

  private elapsedMs = 0;
  private readonly playerGate: ReturnType<typeof createPlayerSnapshotGate>;
  private readonly hordeGate: ReturnType<typeof createHordeSnapshotGate>;
  private readonly missionGate: ReturnType<typeof createMissionSnapshotGate>;

  /** Authoritative player condition (T22) — owns player health/bleeding/pain; combat damage routes here. */
  private readonly playerSurvival: SurvivalSystem;
  /** Data-composed archetype stats (V7) — the source of per-archetype attack damage/cooldown/reach. */
  private readonly archetypes: ArchetypeRegistry;
  /** Session lifecycle store — set to 'dead' once when the player dies (game-over signal for the UI). */
  private readonly session: SessionStore;
  /** Latched so the death transition (set phase 'dead') fires exactly once. */
  private playerDeathHandled = false;

  /** T46 — authoritative door state for the scene's front-door openings (open/closed clears/blocks nav). */
  private readonly doorSystem: DoorSystem;
  /** T108 — authoritative window state (glass/boards). An opening clears its nav cell; boards/intact glass
   *  block it. Seeded from the SAME placements the renderer dresses, so sim + render agree (V26). */
  private readonly windowSystem: WindowSystem;
  /** Resolved structures config (door dims live elsewhere; here: the interaction reach, V4). */
  private readonly structuresCfg = resolveDomain(structuresConfig, REFERENCE_TIER);
  /** Resolved world config — here only for the authored wall height (glass-shatter burst origin, T108). */
  private readonly worldCfg = resolveDomain(worldConfig, REFERENCE_TIER);

  private playerPos: Vec3;
  private playerHeading = 0;
  /** V62 SNEAK: distance (m) the player has travelled since the last emitted footstep stimulus. A stride-length
   *  accumulator so the player's audible loudness is frame-rate-independent and deterministic across replay. */
  private footstepAccumMeters = 0;
  private weatherProfile: WeatherProfile;
  /** Absolute-tick offset so time-of-day survives a save/reload (set from capturedAtTick on load). */
  private tickOffset = 0;

  constructor(opts: GameRuntimeOptions) {
    this.tier = opts.tier ?? REFERENCE_TIER;
    this.scene = opts.scene ?? buildTestBlock();
    this.adapter = opts.adapter;
    this.partition = opts.partition ?? { district: 0, sector: 0 };
    this.rand = mulberry32(opts.scatterSeed ?? 1);
    // T46: doors are the scene's front-door OPENINGS. Initial open/closed is read from the authored nav grid
    // (a blocked door cell starts closed, an open gap starts open) so sim state matches the geometry.
    this.doorSystem = new DoorSystem(this.scene.navGrid, this.scene.exitCells);
    // T108: windows on a deterministic subset of facade cells. Seeded from the SAME placements the renderer
    // dresses (windowPlacements) with the initial glass/board state derived from the house seed — so a window
    // that renders boarded/smashed also simulates that way (V26). Windows govern projectile occlusion + render
    // + interaction; they do NOT alter nav passability (§G — a perimeter window must not unseal room A).
    {
      const w = resolveDomain(worldConfig, this.tier);
      const placements = windowPlacements(this.scene, {
        houseVar: resolveHouseVariation(this.tier),
        stride: w.houseWindowStride,
        boardedFraction: w.houseWindowBoardedFraction,
      });
      this.windowSystem = new WindowSystem(this.scene.navGrid, placements, {
        maxBoards: this.structuresCfg.maxBoardsPerWindow,
        glassShotsToSmash: this.structuresCfg.windowGlassShotsToSmash,
        ticksToBreakBoard: this.structuresCfg.windowZombieTicksPerBoard,
        ticksToSmashGlass: this.structuresCfg.windowZombieTicksToSmashGlass,
      });
    }

    const time = resolveDomain(timeConfig, this.tier);
    this.clock = new FixedClock({
      tickHz: time.tickHz,
      maxFrameSeconds: time.maxFrameSeconds,
      maxCatchUpTicks: time.maxCatchUpTicks,
    });

    this.ids = new IdFactory();
    this.zombies = new SimulationZombies(); // capacity from zombies config (V4)
    this.corpses = new CorpseSystem(resolveCorpseSettings(this.tier)); // pool/lifetime from zombies config (V4)
    this.spatial = new SpatialHash({ tier: this.tier });
    // flow-field cache size lives in the navigation domain — reuse the NavGrid's resolved settings (V4).
    this.flowCache = new FlowFieldCache(this.scene.navGrid.settings.flowFieldCacheSize);
    this.tierManager = new TierManager(this.tier);

    const game = resolveDomain(gameConfig, this.tier);
    this.worldEvents = new RingQueue<WorldEvent>(game.eventPoolSize);
    this.visualEvents = new RingQueue<VisualEvent>(game.eventPoolSize);

    this.playerEntity = this.ids.next<EntityId>('entity');
    const center = this.scene.cellCenter(this.scene.playerCell);
    this.playerPos = { x: center.x, y: this.playerCfg.aimOriginHeight, z: center.z };
    // T22: the player's authoritative condition. Health is normalized 0..1 inside the survival system;
    // it starts at startHealth/maxHealth and seeds the other meters from the player config initials so the
    // published snapshot is unchanged at scenario start. Combat damage (zombie attacks) routes through it.
    this.playerSurvival = new SurvivalSystem({
      entity: this.playerEntity,
      tier: this.tier,
      initial: {
        health: this.playerCfg.startHealth / this.playerCfg.maxHealth,
        hunger: this.playerCfg.initialHunger,
        thirst: this.playerCfg.initialThirst,
        fatigue: this.playerCfg.initialFatigue,
        stress: this.playerCfg.initialStress,
      },
    });
    this.archetypes = buildArchetypeRegistry(this.tier);
    this.session = opts.sessionStore ?? sessionStore;
    this.weatherProfile = this.weatherCfg.defaultProfile as WeatherProfile;

    // Shared stimulus field + audio model. Firing routes a localized sound into the field; only the zombies
    // within its travel radius perceive it and retarget toward it per-zombie (V14 — no global reroute).
    this.stimulus = new StimulusField(this.audioCfg.stimulusFieldCapacity);
    this.audio = new AudioSim({ ids: this.ids, field: this.stimulus, tier: this.tier });

    this.horde = new HordeSimulation({
      zombies: this.zombies,
      spatial: this.spatial,
      scene: this.scene,
      flowCache: this.flowCache,
      tierManager: this.tierManager,
      stimulus: this.stimulus,
      clock: this.clock,
      combatCfg: this.combatCfg,
      perception: this.perception,
      agentRadius: this.collision.defaultAgentRadius,
      playerEntityId: this.playerEntity as number,
      getPlayerPos: () => this.playerPos,
      getTargetSlot: () => this.targetSlot,
      lastDamageTick: this.lastDamageTick,
      lastAttackTick: this.lastAttackTick,
      attackOf: (slot) => this.attackProfileOf(slot),
      damagePlayer: (slot, fraction) => this.damagePlayer(slot, fraction),
    });

    this.combat = new CombatSystem({
      zombies: this.zombies,
      spatial: this.spatial,
      weapons: this.weapons,
      combat: this.combatCfg,
      entityOf: (slot) => this.entityOf(slot),
      nextEventId: () => this.ids.next<EventId>('event'),
      worldEvents: this.worldEvents,
      visualEvents: this.visualEvents,
      onDamaged: (slot) => this.lastDamageTick.set(slot, this.clock.tick),
      onEntityDied: (slot) => this.killZombie(slot),
      // V53/B20: a shot stops at the first projectile-blocking structure cell — never passes through walls.
      firstProjectileBlockerDistance: (origin, dirX, dirZ, range) =>
        this.firstProjectileBlockerDistance(origin, dirX, dirZ, range),
      // Fixed-tick clock source so reload + weapon-swap timers advance deterministically (T74).
      nowTick: () => this.clock.tick,
    });

    this.structuralHooks = {
      nextEventId: () => this.ids.next<EventId>('event'),
      emit: (e) => {
        // breach world-facts feed save/AI/render; queue overflow is explicit, never a silent drop.
        if (!this.worldEvents.push(e)) {
          throw new Error('world-event queue overflow during structural edit');
        }
      },
      openCell: (_module, cell) => this.openBreachedNav(cell),
    };

    // M2 systems: medium-term objective, decisive horde event, district streaming (all config-driven, V4).
    this.objective = new ObjectiveSystem(resolveObjectiveSettings(this.tier));
    this.hordeEvent = new HordeEvent(resolveHordeEventSettings(this.tier));
    this.district = opts.sectors && opts.sectors.length > 0 ? new DistrictModel(opts.sectors, this.tier) : null;
    // Reference mass for event pressure = the district's whole starting population, or a single-block
    // fallback to the gate-0 spawn count so M1 mode still normalizes sanely.
    this.referenceHordeSize = this.district
      ? this.district.abstractTotal() + this.combatCfg.gateZeroZombieCount
      : Math.max(1, this.combatCfg.gateZeroZombieCount);

    const mapStore = opts.mapStore ?? mapViewStore;
    const playerNow: Now = () => this.elapsedMs;
    this.playerGate = createPlayerSnapshotGate(opts.playerStore ?? playerViewStore, this.tier, playerNow);
    this.hordeGate = createHordeSnapshotGate(mapStore, this.tier, playerNow);
    this.missionGate = createMissionSnapshotGate(mapStore, this.tier, playerNow);

    this.persistence = new RuntimePersistence({
      adapter: this.adapter,
      partition: this.partition,
      scene: this.scene,
      zombies: this.zombies,
      ids: this.ids,
      objective: this.objective,
      district: this.district,
      corpses: {
        capture: () => this.corpses.capture(),
        restore: (records) => this.corpses.restore(records),
      },
      entityOf: (slot) => this.entityOf(slot),
      placeZombie: (entity, e) => this.placeZombie(entity, e),
      openBreachedNav: (cell) => this.openBreachedNav(cell),
      getClockTick: () => this.clock.tick,
      getTickOffset: () => this.tickOffset,
      setTickOffset: (tick) => { this.tickOffset = tick; },
      getPlayer: () => ({ pos: this.playerPos, heading: this.playerHeading }),
      setPlayer: (pos, heading) => { this.playerPos = pos; this.playerHeading = heading; },
      getWeather: () => this.weatherProfile,
      setWeather: (profile) => { this.weatherProfile = profile as WeatherProfile; },
    });

    // Real container inventory (T85): player pack + a lootable kitchen cupboard seeded from the T84 loot
    // tables, so the loot UI shows live data the player can actually transfer.
    this.inventory = new InventorySystem({
      catalog: buildDefaultCatalog(this.tier),
      nextEventId: () => this.ids.next<EventId>('event'),
    });
    const playerRef: ContainerRef = { entity: this.playerEntity, container: 'player' };
    this.inventory.addContainer(playerRef, { type: 'backpack' });
    this.namedContainers.set('player', playerRef);
    // T108: equip the player with a hammer + a stack of planks by default so window board-up works out of the
    // box (temporary starter loadout — adjust later). The hammer also doubles as a breaching tool (V43 gating).
    for (const [item, count] of [[ITEM.KitchenKnife, 1], [ITEM.Bandage, 2], [ITEM.WaterBottle, 1], [ITEM.Hammer, 1], [ITEM.WoodPlank, 6]] as const) {
      this.inventory.seed(playerRef, item as ItemId, count);
    }
    // World containers use a SYNTHETIC id space (not `this.ids`) + a SEPARATE loot rng, so seeding the world
    // never perturbs the IdFactory counters or the spawn-scatter rng that determinism/replay depend on (V26).
    // Each container is anchored at a FIXED authored cell (lootableContainerCells) — a corner of the player's
    // room, NOT the player cell — so it reads as an object in the world, not a thing that trails the player.
    const lootRng = mulberry32((opts.scatterSeed ?? 1) ^ 0x10c7);
    let containerSlot = 0;
    lootableContainerCells(this.scene).forEach((placement) => {
      const ref: ContainerRef = { entity: (WORLD_CONTAINER_ENTITY + containerSlot++) as EntityId, container: placement.label };
      this.inventory.addContainer(ref, { type: 'cupboard' });
      this.namedContainers.set(placement.label, ref);
      const center = this.scene.cellCenter(placement.cell);
      this.worldContainers.push({ x: center.x, z: center.z, label: placement.label });
      for (const s of rollLoot('kitchen', lootRng)) this.inventory.seed(ref, s.item, s.count);
    });

    // P1d: every CONTAINER furniture piece (furnishHouse → PlacedFurniture with a non-null `container`) becomes a
    // real lootable world container — same wiring as the cupboard above (synthetic id space + the SAME separate
    // loot rng, so seeding the world never perturbs the sim rand / id streams, V26). Anchored at the furniture's
    // world cell; the room-type → LootSource mapping is baked into the piece by furnishRoom (fridge → 'kitchen',
    // dresser → 'bedroom', medicineCabinet → 'bathroom', …). Each gets a UNIQUE display label (the interactable
    // label == the namedContainers key == the loot-menu container name) so duplicates across houses don't collide.
    const labelCounts = new Map<string, number>();
    for (const piece of this.scene.placedFurniture ?? []) {
      if (piece.container === null) continue;
      const base = FURNITURE_CONTAINER_LABEL[piece.kind] ?? piece.kind;
      const n = (labelCounts.get(base) ?? 0) + 1;
      labelCounts.set(base, n);
      const label = n === 1 ? base : `${base} ${n}`;
      const ref: ContainerRef = { entity: (WORLD_CONTAINER_ENTITY + containerSlot++) as EntityId, container: label };
      this.inventory.addContainer(ref, { type: 'cupboard' });
      this.namedContainers.set(label, ref);
      const center = this.scene.cellCenter({ cx: piece.cx, cy: piece.cy });
      this.worldContainers.push({ x: center.x, z: center.z, label });
      for (const s of rollLoot(piece.container, lootRng)) this.inventory.seed(ref, s.item, s.count);
    }

    this.registerSystems();
  }

  /** Snapshot the player + nearby containers for the inventory view store (T62/T85). */
  inventorySnapshot(): ContainerView[] {
    const out: ContainerView[] = [];
    for (const [name, ref] of this.namedContainers) {
      const slots = this.inventory.contents(ref).map((s) => ({ item: s.item as number, count: s.count }));
      out.push({ container: name, capacity: 0, weight: this.inventory.containerWeight(ref), slots });
    }
    return out;
  }

  /** Transfer a whole item stack between two named containers (T85). Returns true on success. */
  transferItem(fromName: string, toName: string, item: number): boolean {
    const from = this.namedContainers.get(fromName);
    const to = this.namedContainers.get(toName);
    if (!from || !to) return false;
    const count = this.inventory.count(from, item as ItemId);
    if (count <= 0) return false;
    return this.inventory.transfer(this.ids.next<CommandId>('command'), item as ItemId, from, to, count).result.ok;
  }

  /** Absolute tick (survives reload via tickOffset) — the basis for objective + event timing. */
  private absTick(): number {
    return this.clock.tick + this.tickOffset;
  }

  // ---- public surface ----

  get tick(): number {
    return this.clock.tick;
  }

  get aliveCount(): number {
    return this.zombies.count;
  }

  get navRevision(): number {
    return this.scene.navGrid.navRevision;
  }

  player(): Readonly<Vec3> {
    return this.playerPos;
  }

  /** Count alive zombies within `radius` m of the player (XZ). Drives the proximity-scaled horde audio bed —
   *  the drone answers "how many are near ME", not the global embodied count (which is always high). */
  nearbyHordeCount(radius: number): number {
    return this.zombies.nearbyCount(this.playerPos.x, this.playerPos.z, radius);
  }

  /**
   * True if the player's body (bodyRadius, V42) overlaps nav cell (cx,cy). Used to REFUSE closing a door onto
   * the player: blocking the cell the player occupies traps them — every wall-slide candidate then fails the
   * radius-aware walkable test (movePlayer). Closest-point-on-cell-AABB vs player centre = exactly the trap
   * condition, so refusing close whenever this is true is the precise guard.
   */
  private playerOverlapsCell(cx: number, cy: number): boolean {
    const s = this.scene.navGrid.settings.navCellSize;
    const px = Math.min(Math.max(this.playerPos.x, cx * s), (cx + 1) * s);
    const pz = Math.min(Math.max(this.playerPos.z, cy * s), (cy + 1) * s);
    const dx = this.playerPos.x - px;
    const dz = this.playerPos.z - pz;
    const r = this.playerCfg.bodyRadiusMeters;
    return dx * dx + dz * dz < r * r;
  }

  /** True once the player's health has reached 0 (lethal game-over). Player control is halted while dead. */
  isPlayerDead(): boolean {
    return !this.playerSurvival.alive;
  }

  /** Player health as a normalized 0..1 fraction (diagnostics/tests; the HUD reads the count via snapshot). */
  playerHealthFraction(): number {
    return this.playerSurvival.state.health;
  }

  /** Player sprint stamina as a 0..1 fraction (diagnostics/tests — kept internal this wave, not in the
   *  frozen snapshot contract). Drains while sprinting, regenerates while walking; fatigue caps it. */
  playerStaminaFraction(): number {
    return this.playerSurvival.stamina;
  }

  /** Player facing in radians (atan2(dirZ, dirX)); drives the default fire direction + render heading. */
  playerAim(): number {
    return this.playerHeading;
  }

  /**
   * The flow-field target CELL a live zombie chose this perception tick (test/diagnostics): the player cell
   * if it sees the player, the cell of the loudest sound it hears, or -1 when it has no target (idle). There
   * is no single global target anymore — sound is localized perception (V14). Throws on an unmapped entity.
   */
  zombieTargetCell(entity: EntityId): number {
    const slot = this.entityToSlot.get(entity);
    if (slot === undefined || !this.zombies.isAlive(slot)) {
      throw new Error(`cannot read target of entity ${entity}: not alive`);
    }
    return this.zombies.getTarget(slot);
  }

  /** Active weather profile (drives the renderer's fog/grading; default from weather config). */
  get weather(): WeatherProfile {
    return this.weatherProfile;
  }

  /** Atmospheric severity 0..1 for the active weather profile (fog extinction + grading input). */
  get weatherSeverity(): number {
    return weatherSeverity(this.weatherCfg, this.weatherProfile);
  }

  setWeather(profile: WeatherProfile): void {
    this.weatherProfile = profile;
  }

  /**
   * Day fraction 0..1 derived purely from the authoritative clock (0 = midnight, 0.5 = noon). The render
   * lane maps this to the sun/moon angle; the sim never owns lighting. Survives reload via tickOffset.
   */
  timeOfDay(): number {
    const absTick = this.clock.tick + this.tickOffset;
    const seconds = absTick * this.clock.tickSeconds;
    const t = (this.weatherCfg.startTimeOfDay + seconds / this.weatherCfg.dayLengthSeconds) % 1;
    return t < 0 ? t + 1 : t;
  }

  /** Set the player's aim heading from a world-space direction (mouse aim). Zero vector is ignored. */
  aim(dirX: number, dirZ: number): void {
    if (dirX === 0 && dirZ === 0) return;
    this.playerHeading = Math.atan2(dirZ, dirX);
  }

  /**
   * Move the player by a normalized intent over `dtSeconds` at the configured walk speed. The engine
   * validates against walkable nav cells (V1: UI issues intent, engine authorizes) and slides along walls
   * rather than sticking. Returns true if the player actually moved.
   *
   * `sprint` is the escape lever (outrun the horde): when requested AND stamina allows it, the move speed
   * is scaled by `playerSprintSpeedMultiplier` and stamina drains this frame; otherwise normal speed and
   * stamina regenerates (T22 owns the pool + fatigue coupling). A dead player never sprints (control is
   * halted before this runs). Drain/regen scale by `dtSeconds` since this is driven per-frame.
   *
   * V62 SNEAK stance: `sneak` (Ctrl) emits LESS footstep noise than walking (sneak < walk < sprint). The horde
   * only ever learns of the player through stimuli (V14), so the player emits a footstep stimulus every stride
   * of travel, scaled by the active stance's noise multiplier — a sneaking player is genuinely harder to hear.
   * Sprint takes precedence over sneak (you cannot sprint silently). This is a real, deterministic sim event
   * driven purely by movement intent, so it stays consistent across replay (V26).
   */
  movePlayer(dirX: number, dirZ: number, dtSeconds: number, sprint = false, sneak = false): boolean {
    if (this.isPlayerDead()) return false; // game-over: player control is halted (V12-safe — sim keeps running)
    const len = Math.hypot(dirX, dirZ);
    if (len === 0 || dtSeconds <= 0) return false;
    const sprinting = this.playerSurvival.applyStamina(sprint, dtSeconds);
    const speed = this.playerCfg.moveSpeedMetersPerSecond * (sprinting ? this.playerCfg.playerSprintSpeedMultiplier : 1);
    const stepX = (dirX / len) * speed * dtSeconds;
    const stepZ = (dirZ / len) * speed * dtSeconds;
    const ox = this.playerPos.x;
    const oz = this.playerPos.z;
    const nx = ox + stepX;
    const nz = oz + stepZ;
    // T58/V42: radius-aware so the player body never clips half into a wall. The edge-wall test additionally
    // rejects a step crossing an interior partition between two walkable cells (must use the doorway).
    const r = this.playerCfg.bodyRadiusMeters;
    const grid = this.scene.navGrid;
    let moved = false;
    if (isWalkableRadius(this.scene, nx, nz, r) && !segmentCrossesWall(grid, ox, oz, nx, nz)) {
      this.playerPos = { x: nx, y: this.playerPos.y, z: nz };
      moved = true;
    } else if (isWalkableRadius(this.scene, nx, oz, r) && !segmentCrossesWall(grid, ox, oz, nx, oz)) {
      // Wall slide: keep the component that stays walkable (standard collision response, not a fallback).
      this.playerPos = { x: nx, y: this.playerPos.y, z: oz };
      moved = true;
    } else if (isWalkableRadius(this.scene, ox, nz, r) && !segmentCrossesWall(grid, ox, oz, ox, nz)) {
      this.playerPos = { x: ox, y: this.playerPos.y, z: nz };
      moved = true;
    }
    if (!moved) return false;
    // V62: emit stance-scaled footstep noise for the ACTUAL displacement (slides emit less than a clear step).
    const stanceNoise = sprinting
      ? this.audioCfg.sprintNoiseMultiplier
      : sneak
        ? this.audioCfg.sneakNoiseMultiplier
        : 1;
    this.accumulateFootstepNoise(Math.hypot(this.playerPos.x - ox, this.playerPos.z - oz), stanceNoise);
    return true;
  }

  /**
   * V62 SNEAK: accrue travelled distance and emit a footstep stimulus the horde hears each `footstepStrideMeters`.
   * Intensity is scaled by the active stance (sneak < walk < sprint), so sneaking is quieter than walking the same
   * distance. Stride-accumulated so loudness is frame-rate-independent; deterministic (driven by movement intent).
   */
  private accumulateFootstepNoise(distanceMeters: number, stanceNoise: number): void {
    if (distanceMeters <= 0) return;
    this.footstepAccumMeters += distanceMeters;
    const stride = this.audioCfg.footstepStrideMeters;
    while (this.footstepAccumMeters >= stride) {
      this.footstepAccumMeters -= stride;
      this.audio.hearEvent('footstep', this.playerPos.x, this.playerPos.z, this.clock.tick, { intensityScale: stanceNoise });
    }
  }

  /** The mid structural cell of the destructible section — the UI's default breach/board target. */
  defaultBreachCell(): number {
    return this.scene.wall.packCell(0, 0, Math.floor(this.scene.wall.sizeZ / 2));
  }

  // ---- T46 doors: authoritative open/close state (commands resolved here, never render-driven) ----

  /** Live door views for the renderer (leaf orientation + rotation) + interaction resolution. */
  doorViews(): readonly DoorView[] {
    return this.doorSystem.list();
  }

  /** Open/close the door at a nav cell (authoritative). Clearing the cell opens nav + sight + sound through
   *  it; blocking restores it (V5 local edit). Returns the resulting access, or undefined if no door/locked. */
  setDoor(navCell: number, open: boolean): 'open' | 'closed' | 'locked' | undefined {
    if (open) return this.doorSystem.open(navCell) ? 'open' : this.doorSystem.accessOf(navCell);
    // Closing: refuse if the player's body overlaps the door cell — blocking it would trap them. No-op return
    // of the current (still-open) access so the UI shows the close simply did not take (V42 trap guard).
    const { cx, cy } = this.scene.navGrid.coordOf(navCell);
    if (this.playerOverlapsCell(cx, cy)) return this.doorSystem.accessOf(navCell);
    return this.doorSystem.close(navCell) ? 'closed' : this.doorSystem.accessOf(navCell);
  }

  /** Toggle the door NEAREST the player within interaction reach (the wheel / prompt action). Returns the new
   *  access, or null when no door is in reach. Input-driven (a command), not render-driven (V12). */
  toggleNearestDoor(): 'open' | 'closed' | 'locked' | null {
    const near = this.doorSystem.nearest(this.playerPos.x, this.playerPos.z, this.structuresCfg.interactionRangeMeters);
    if (!near) return null;
    // Closing onto the player traps them (V42) — refuse the close half of the toggle when the player's body
    // overlaps the door cell; opening is always safe. Return the unchanged access so the prompt stays honest.
    if (near.door.access === 'open' && this.playerOverlapsCell(near.door.cx, near.door.cy)) {
      return near.door.access;
    }
    return this.doorSystem.toggle(near.navCell) ?? null;
  }

  // ---- T108 windows: authoritative glass/board state (commands resolved here, never render-driven) ----

  /** Live window views for the renderer (mesh swap) + interaction resolution. */
  windowViews(): readonly WindowView[] {
    return this.windowSystem.list();
  }

  /** The window NEAREST the player within interaction reach, or null. */
  private nearestWindowInReach(): { navCell: number; window: WindowView } | null {
    const near = this.windowSystem.nearest(this.playerPos.x, this.playerPos.z, this.structuresCfg.interactionRangeMeters);
    return near ? { navCell: near.navCell, window: near.window } : null;
  }

  /**
   * Shared feedback for EVERY pane smash (verb / projectile / zombie attrition): push a `glassShatter` visual
   * event (the render's shard burst) + a loud `glass` stimulus the horde hears (V14). Shards spray off the pane
   * along the wall's facing axis, signed toward `(towardX,towardZ)` — the smasher's side (the player for the
   * verb; the bullet's exit for a shot) so the burst reads from the camera. Burst origin ≈ window-centre height.
   */
  private emitGlassShatter(navCell: number, towardX: number, towardZ: number): void {
    const grid = this.scene.navGrid;
    const cs = grid.settings.navCellSize;
    const { cx, cy } = grid.coordOf(navCell);
    const wx = (cx + 0.5) * cs;
    const wz = (cy + 0.5) * cs;
    const blocked = (bx: number, by: number): boolean =>
      bx < 0 || by < 0 || bx >= grid.width || by >= grid.height ? true : grid.isBlocked(grid.index(bx, by));
    const alongX = blocked(cx - 1, cy) && blocked(cx + 1, cy); // wall runs along X → pane faces ±Z
    let nx = 0;
    let nz = 0;
    if (alongX) nz = Math.sign(towardZ - wz) || 1;
    else nx = Math.sign(towardX - wx) || 1;
    const y = this.worldCfg.buildingWallHeightMeters * 0.55; // ~window-centre height
    this.visualEvents.push({ kind: 'glassShatter', id: this.ids.next<EventId>('event'), x: wx, y, z: wz, nx, nz });
    this.audio.hearEvent('glass', wx, wz, this.clock.tick);
  }

  /** True iff the player's pack holds at least one of `item`. */
  private playerHas(item: number): boolean {
    const ref = this.namedContainers.get('player');
    return ref ? this.inventory.count(ref, item as ItemId) > 0 : false;
  }

  /** Smash the intact pane of the NEAREST window in reach (the "smash glass" verb). On a real smash the
   *  pane→void swap is reflected by syncWindows AND a loud GLASS stimulus is emitted at the window so the
   *  shatter is audible + draws the horde (V14). Returns true only when an intact pane was actually broken. */
  smashNearestWindow(): boolean {
    const near = this.nearestWindowInReach();
    if (!near || !this.windowSystem.smashGlass(near.navCell)) return false;
    this.emitGlassShatter(near.navCell, this.playerPos.x, this.playerPos.z); // shards spray toward the player
    return true;
  }

  /**
   * Vault the player THROUGH the NEAREST window OPENING in reach (the "climb through" verb). A discrete,
   * player-ONLY traversal to the walkable cell on the FAR side of the window's wall: it never mutates nav
   * passability (V68 — the cell stays a blocked wall for AI/pathing + the §G room-seal holds), only the
   * player's own position moves across the 1-cell wall. No-op unless the window is an opening (glass gone,
   * no boards) AND the far cell is walkable. Climbing is noisy → emits an impact stimulus the horde hears
   * (V14). Returns true on a successful vault.
   */
  climbThroughNearestWindow(): boolean {
    const near = this.nearestWindowInReach();
    if (!near || !this.windowSystem.isOpening(near.navCell)) return false; // glass intact or boarded — can't climb
    const grid = this.scene.navGrid;
    const cs = grid.settings.navCellSize;
    const wcx = near.window.cx;
    const wcy = near.window.cy;
    const blocked = (cx: number, cy: number): boolean =>
      cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height ? true : grid.isBlocked(grid.index(cx, cy));
    // Wall normal: a window whose ±X neighbours are BOTH walls sits in an X-running wall → cross along Z.
    const alongX = blocked(wcx - 1, wcy) && blocked(wcx + 1, wcy);
    let dcx = wcx;
    let dcy = wcy;
    if (alongX) {
      const side = Math.sign(this.playerPos.z - (wcy + 0.5) * cs) || 1; // which side of the wall the player is on
      dcy = wcy - side; // land on the OPPOSITE side of the window
    } else {
      const side = Math.sign(this.playerPos.x - (wcx + 0.5) * cs) || 1;
      dcx = wcx - side;
    }
    const fx = (dcx + 0.5) * cs;
    const fz = (dcy + 0.5) * cs;
    if (!isWalkableRadius(this.scene, fx, fz, this.playerCfg.bodyRadiusMeters)) return false; // far side blocked
    this.playerPos = { x: fx, y: this.playerPos.y, z: fz };
    this.audio.hearEvent('impact', near.window.x, near.window.z, this.clock.tick);
    return true;
  }

  /**
   * Board up the NEAREST window in reach (the "board up" verb). Authoritative gating (V1/V43): needs a hammer
   * AND enough planks; on success the planks are consumed and one board is added (blocks the opening again).
   * Returns true only when a board was actually added.
   */
  boardNearestWindow(): boolean {
    const near = this.nearestWindowInReach();
    const ref = this.namedContainers.get('player');
    if (!near || !ref) return false;
    if (!this.playerHas(ITEM.Hammer)) return false; // tool required to nail boards
    const cost = this.structuresCfg.windowPlankCostPerBoard;
    if (this.inventory.count(ref, ITEM.WoodPlank as ItemId) < cost) return false;
    if (!this.windowSystem.addBoard(near.navCell)) return false; // already at max — do not spend planks
    this.inventory.take(ref, ITEM.WoodPlank as ItemId, cost);
    return true;
  }

  /** Pry one board off the NEAREST window in reach (the "remove boards" verb) — returns the planks. */
  unboardNearestWindow(): boolean {
    const near = this.nearestWindowInReach();
    const ref = this.namedContainers.get('player');
    if (!near || !ref) return false;
    if (!this.windowSystem.removeBoard(near.navCell)) return false;
    // Return the planks the board was made of (best-effort: the pack may be over capacity — then they drop).
    try {
      this.inventory.seed(ref, ITEM.WoodPlank as ItemId, this.structuresCfg.windowPlankCostPerBoard);
    } catch {
      // pack full — the planks are lost rather than crashing the command (acceptable; they were already used).
    }
    return true;
  }

  /**
   * The live interactable targets for the slice (T60): every door, the destructible wall section, and the
   * lootable kitchen cupboard (anchored at the player's start room). Used by `nearestInteractionPrompt` and
   * the interaction wheel to offer verbs by the NEAREST target's TYPE.
   */
  interactables(): InteractionTargetWorld[] {
    const out: InteractionTargetWorld[] = [];
    for (const d of this.doorSystem.list()) {
      out.push({ kind: 'door', access: d.access, x: d.x, z: d.z, label: 'Door' });
    }
    // T108: every window, carrying its live glass + board state so the wheel/prompt offer the state-driven
    // verbs (boarded → remove boards, intact → smash glass, opening → climb / board up).
    for (const w of this.windowSystem.list()) {
      out.push({ kind: 'window', glass: w.glass, boards: w.boards, x: w.x, z: w.z, label: 'Window' });
    }
    // The destructible §G wall section — anchored at its mid nav cell.
    const wallNav = this.scene.navCellForStructuralCell(this.defaultBreachCell());
    const wallC = this.scene.cellCenter(wallNav);
    const wallCell = this.scene.wall.getCell(this.defaultBreachCell());
    out.push({ kind: 'structure', breached: wallCell?.breached ?? false, x: wallC.x, z: wallC.z, label: 'Wall section' });
    // The lootable cupboard(s) at their FIXED authored cells — only nearest when the player is actually beside
    // the cabinet (range-gated by nearestInteractable), never house-wide (the old playerCell anchor bug).
    for (const c of this.worldContainers) {
      out.push({ kind: 'container', x: c.x, z: c.z, label: c.label });
    }
    return out;
  }

  /** Physical dims used to SIZE the active-interactable highlight box (typed config + scene cell size, V4). */
  private highlightDims(): HighlightDims {
    return {
      navCellSize: this.scene.navGrid.settings.navCellSize,
      defaultHeightMeters: this.structuresCfg.interactionHighlightHeightMeters,
      cupboardWidthMeters: this.structuresCfg.cupboardWidthMeters,
      cupboardDepthMeters: this.structuresCfg.cupboardDepthMeters,
      cupboardHeightMeters: this.structuresCfg.cupboardHeightMeters,
    };
  }

  /**
   * The NEAREST interactable in reach as a placed + SIZED highlight box (world centre + axis-aligned bounds +
   * kind), or null when nothing is in reach (T60/V29). The render lane draws ONE colour-coded glowing outline
   * at this box so the player sees WHICH object the "{key} to {action}" prompt refers to. Pure read of the
   * live sim state — the frame loop polls it each frame and hides the highlight when this returns null.
   */
  nearestInteractableHighlight(): InteractionHighlightTarget | null {
    const near = nearestInteractable(this.interactables(), this.playerPos.x, this.playerPos.z, this.structuresCfg.interactionRangeMeters);
    return near ? highlightBoxFor(near.target, this.highlightDims()) : null;
  }

  /** The "{key} to {action}" prompt for the NEAREST interactable in reach, or null (T60). Pure read of the
   *  live sim state — the HUD polls it each frame and re-renders only when it changes (V1/V11). */
  nearestInteractionPrompt(key: string): InteractionPrompt | null {
    const near = nearestInteractable(this.interactables(), this.playerPos.x, this.playerPos.z, this.structuresCfg.interactionRangeMeters);
    return near ? interactionPrompt(near.target, key) : null;
  }

  /** The NEAREST interactable target in reach (full state), or null — the wheel resolves its gated verbs. */
  nearestInteractableTarget(): InteractionTargetWorld | null {
    const near = nearestInteractable(this.interactables(), this.playerPos.x, this.playerPos.z, this.structuresCfg.interactionRangeMeters);
    return near ? near.target : null;
  }

  /**
   * Validate + apply a contract Command (V1: UI issues intent, engine validates, may fail with a reason).
   * Movement + firing flow through their own authoritative methods (no command kind exists for them in the
   * frozen contract); this routes the structure + targeting intents the contract DOES model.
   */
  dispatch(cmd: Command): CommandResult {
    switch (cmd.kind) {
      case 'modifyStructure':
        return this.applyStructureOp(cmd);
      case 'selectTarget':
        this.selectTarget(cmd.target);
        return { ok: true, id: cmd.id };
      case 'confirmAction':
        return this.applyConfirmAction(cmd);
      default:
        return { ok: false, id: cmd.id, reason: `runtime does not handle command '${cmd.kind}'` };
    }
  }

  /**
   * Route medium-term OBJECTIVE intents (V1) modelled by the frozen `confirmAction` command. Each action
   * advances the objective FSM and may fail with an explicit reason (e.g. advancing before the phase's
   * precondition is met). Arming the evacuation is what triggers the decisive horde event (the climax).
   */
  private applyConfirmAction(
    cmd: Extract<Command, { kind: 'confirmAction' }>,
  ): CommandResult {
    switch (cmd.action) {
      case 'objective.collectPart':
        this.objective.collectPart();
        return { ok: true, id: cmd.id };
      case 'objective.repair':
        // One decisive repair action completes the required work (accumulation is unit-tested directly).
        this.objective.applyRepairTicks(this.objective.snapshot(this.absTick()).repairRequiredTicks);
        return { ok: true, id: cmd.id };
      case 'objective.advance': {
        const wasCallEvac = this.objective.currentPhase === 'callEvacuation';
        const advanced = this.objective.advance(this.absTick());
        if (!advanced) return { ok: false, id: cmd.id, reason: `objective cannot advance from '${this.objective.currentPhase}'` };
        // Advancing OUT of callEvacuation arms the decisive horde event (the climax).
        if (wasCallEvac) this.hordeEvent.arm(this.absTick());
        return { ok: true, id: cmd.id };
      }
      case 'objective.reachExit':
        return this.objective.reachExit()
          ? { ok: true, id: cmd.id }
          : { ok: false, id: cmd.id, reason: 'not evacuating' };
      default:
        return { ok: false, id: cmd.id, reason: `unknown action '${cmd.action}'` };
    }
  }

  /**
   * Ignite a structural route cell (a horde-event lever — fire reroutes/stalls the mass). Not modelled by
   * the frozen StructureOp set, so it is a runtime method like fire()/breachWall(); it emits a fireIgnited
   * world fact for render/AI/save consumers. Throws on an unknown cell (V4 — no silent miss).
   */
  igniteRoute(cell: number): void {
    if (!this.scene.wall.getCell(cell)) throw new Error(`cannot ignite unknown structural cell ${cell}`);
    this.burningRoutes.add(cell);
    if (!this.worldEvents.push({ kind: 'fireIgnited', id: this.ids.next<EventId>('event'), module: this.scene.moduleId, cell })) {
      throw new Error('world-event queue overflow during ignite');
    }
  }

  /** Whether a structural route cell is currently on fire (test/diagnostics + horde-event input). */
  isRouteBurning(cell: number): boolean {
    return this.burningRoutes.has(cell);
  }

  /** Preview the decisive event against the CURRENT player-shaped structural state (test/diagnostics). */
  evaluateEventNow(): HordeEventResult {
    return this.hordeEvent.peek(this.currentEventInput());
  }

  /** Build the decisive-event input from the live, player-shaped structural state + total horde mass. */
  private currentEventInput() {
    const routes = routeStatesFromModule(this.scene.wall, {
      cellCount: this.scene.wall.sizeZ,
      packCell: (z) => this.scene.wall.packCell(0, 0, z),
      isBurning: (cell) => this.burningRoutes.has(cell),
    });
    const hordeSize = this.zombies.count + (this.district ? this.district.abstractTotal() : 0);
    return { routes, hordeSize, referenceHordeSize: this.referenceHordeSize };
  }

  private applyStructureOp(
    cmd: Extract<Command, { kind: 'modifyStructure' }>,
  ): CommandResult {
    if ((cmd.module as number) !== (this.scene.moduleId as number)) {
      return { ok: false, id: cmd.id, reason: `unknown module ${cmd.module as number}` };
    }
    const cell = this.scene.wall.getCell(cmd.cell);
    if (!cell) return { ok: false, id: cmd.id, reason: `no structural cell ${cmd.cell}` };
    switch (cmd.op) {
      case 'breach': {
        this.scene.wall.applyDamage(cmd.cell, cell.maxStrength, this.structuralHooks);
        return { ok: true, id: cmd.id };
      }
      case 'board':
      case 'reinforce': {
        // B17/V1: a breached (or empty) cell cannot be reinforced — `wall.reinforce` THROWS on it. Return a
        // graceful command failure instead of letting the exception crash the UI ("Board wall" error).
        if (cell.breached) {
          return { ok: false, id: cmd.id, reason: `cannot board a breached cell ${cmd.cell}` };
        }
        this.scene.wall.reinforce(cmd.cell, this.scene.wall.structures.defaultCellStrength);
        return { ok: true, id: cmd.id };
      }
      default:
        return { ok: false, id: cmd.id, reason: `unsupported structure op '${cmd.op}'` };
    }
  }

  /**
   * Resolve a slot's melee parameters from its archetype (V7/V14). `damageFraction` normalizes the
   * archetype's count damage by player max health so it composes with the survival system's 0..1 health;
   * `cooldownTicks` converts the archetype's per-attack cadence (seconds) to fixed ticks (>= 1, V12).
   */
  private attackProfileOf(slot: ZombieSlot): { damageFraction: number; cooldownTicks: number; rangeMeters: number } {
    const a = this.archetypes.byIndexOf(this.zombies.getArchetype(slot));
    return {
      damageFraction: a.attack.damage / this.playerCfg.maxHealth,
      cooldownTicks: Math.max(1, Math.round(a.attack.cooldownSeconds / this.clock.tickSeconds)),
      rangeMeters: a.attack.rangeMeters,
    };
  }

  /**
   * Apply a zombie melee hit to the player (called by the horde attack step). Damage routes through the
   * player survival system (T22 — the single owner of player health). Crossing 0 health triggers the
   * one-shot death transition. A hit on an already-dead player is a no-op (the body keeps milling).
   */
  private damagePlayer(_slot: ZombieSlot, damageFraction: number): void {
    if (this.isPlayerDead()) return;
    this.playerSurvival.damage(damageFraction);
    if (this.isPlayerDead()) this.onPlayerDied();
  }

  /** One-shot lethal transition: publish the 'dead' lifecycle phase so the UI can show game-over (V1). */
  private onPlayerDied(): void {
    if (this.playerDeathHandled) return;
    this.playerDeathHandled = true;
    this.session.getState().setPhase('dead');
  }

  /** Slot -> stable EntityId (the seam lane-S left to the integrator). Throws if the slot is unmapped. */
  entityOf(slot: ZombieSlot): EntityId {
    const e = this.slotToEntity.get(slot);
    if (e === undefined) throw new Error(`slot ${slot} has no EntityId mapping`);
    return e;
  }

  slotOf(entity: EntityId): ZombieSlot | undefined {
    return this.entityToSlot.get(entity);
  }

  isAliveEntity(entity: EntityId): boolean {
    const slot = this.entityToSlot.get(entity);
    return slot !== undefined && this.zombies.isAlive(slot);
  }

  /**
   * Current transform of a struck body by entity (Bug A render anchor): a LIVE zombie reports upright
   * (lying 0) at its sim position; once killed, its lingering CORPSE reports toppled (lying 1) at the spot
   * it fell. Returns null when the body is gone (despawned with no corpse / corpse pruned) so its gore fades
   * out. Read-only — the render lane reprojects zombie blood-gore onto this each frame; never feeds the sim.
   */
  bodyAnchor(entity: EntityId): { x: number; y: number; z: number; heading: number; lying: number; groundY: number } | null {
    const slot = this.entityToSlot.get(entity);
    if (slot !== undefined && this.zombies.isAlive(slot)) {
      const pos: [number, number, number] = [0, 0, 0];
      this.zombies.getPosition(slot, pos);
      return { x: pos[0], y: pos[1], z: pos[2], heading: this.zombies.getHeading(slot), lying: 0, groundY: pos[1] };
    }
    const corpse = this.corpses.byEntity(entity as unknown as number);
    if (corpse) return { x: corpse.x, y: corpse.y, z: corpse.z, heading: corpse.heading, lying: 1, groundY: corpse.y };
    return null;
  }

  /**
   * Advance the authoritative sim by `dtSeconds` of real time: integrate the fixed clock, run every due
   * scheduled system per tick, then publish throttled view snapshots (V12/V1/V11). Returns ticks run.
   */
  update(dtSeconds: number): number {
    const ticks = this.clock.advance(dtSeconds);
    this.elapsedMs += dtSeconds * 1000;
    // Run each fixed tick with its OWN absolute index (mirrors FrameLoop) so interval-cadence systems
    // (perception/tier/sound) fire on the right ticks even when a single variable-dt frame advances many
    // ticks. Passing a constant final tick here silently breaks interval cadence (V12).
    for (let i = 0; i < ticks; i++) {
      const tick = this.clock.tick - (ticks - 1 - i);
      const ctx: SystemContext = { tick, tickSeconds: this.clock.tickSeconds };
      this.scheduler.runTick(ctx);
    }
    this.publishSnapshots();
    return ticks;
  }

  /** Fire one firearm shot immediately (deterministic). Combat is resolved authoritatively now, and the
   *  gunshot emits a sound stimulus at the muzzle so the horde is drawn to the noise (sound attraction). */
  fire(dirX: number, dirZ: number, region: AnatomyRegion, opts: { rollHitLocation?: boolean } = {}): ShotResult {
    const result = this.combat.fire(this.playerPos, dirX, dirZ, region, opts);
    // Only a round that actually fired makes noise — a dry click (empty mag) doesn't draw the horde (T74).
    if (result.firedRounds === undefined || result.firedRounds > 0) this.emitGunfire();
    return result;
  }

  /** Reload the current weapon (T74) — refills the magazine from reserve over the weapon's reload time. */
  reloadWeapon(): boolean {
    return this.combat.reload();
  }

  /** Cycle the equipped weapon (T74). */
  cycleWeapon(dir: 1 | -1): void {
    this.combat.cycleWeapon(dir);
  }

  /** Current ammo + weapon for the HUD (T74). */
  ammoStatus(): { magazine: number; reserve: number; reloading: boolean } {
    return this.combat.currentAmmo();
  }
  currentWeaponId(): string {
    return this.combat.currentWeaponId();
  }

  /**
   * V53/B20 structure-occlusion query for the combat lane: march the firearm ray in steps <= one nav
   * cell and return the distance (m) to the FIRST projectile-blocking structure cell, or null if the
   * line of fire stays clear to `range`. A cell blocks when it is NOT walkable in the authoritative nav
   * grid — i.e. an intact wall, the un-breached destructible section, a closed/locked door or a boarded
   * panel. A breach or open door clears its nav cell (V5 — openBreachedNav), so it does NOT block. This
   * is the single source of truth shared with line-of-sight (the renderer never decides occlusion).
   */
  private firstProjectileBlockerDistance(
    origin: Readonly<Vec3>,
    dirX: number,
    dirZ: number,
    range: number,
  ): number | null {
    const cellSize = this.scene.navGrid.settings.navCellSize;
    const step = cellSize * this.combatCfg.projectileOcclusionStepRatio; // <= cell size, config-driven (V4)
    const steps = Math.max(1, Math.ceil(range / step));
    for (let i = 1; i <= steps; i++) {
      const d = Math.min(i * step, range);
      const wx = origin.x + dirX * d;
      const wz = origin.z + dirZ * d;
      if (!this.scene.isWalkableWorld(wx, wz)) {
        // T108: a window cell is always a blocked WALL cell in the nav grid (§G — windows are not walk-through
        // openings), so the occlusion query resolves window pass-through HERE. An OPENING (glassless/smashed,
        // unboarded) lets the round pass; an intact pane SHATTERS when the round crosses it (then passes, or
        // stops at the glass if the pane still has HP); boards + real walls block.
        const { cx, cy } = this.scene.navGrid.worldToCell(wx, wz);
        const navCell = this.windowSystem.cellOf(cx, cy);
        if (navCell >= 0) {
          if (this.windowSystem.isOpening(navCell)) continue; // smashed/glassless hole — shot flies through
          if (this.windowSystem.glassOf(navCell) === 'intact' && (this.windowSystem.boardsOf(navCell) ?? 0) === 0) {
            if (this.windowSystem.applyGlassHit(navCell)) {
              this.emitGlassShatter(navCell, wx + dirX, wz + dirZ); // shards spray along the bullet's travel
              continue; // shattered → shot continues past the opening
            }
            return d; // pane absorbed the hit but did not break (HP > 1) — round stops at the glass
          }
          // a boarded window blocks the round (falls through to the wall return below)
        }
        return d;
      }
      if (d >= range) break;
    }
    return null;
  }

  /** Emit a gunshot sound stimulus at the player's current muzzle position into the shared field. */
  private emitGunfire(): void {
    this.audio.hearEvent('gunfire', this.playerPos.x, this.playerPos.z, this.clock.tick);
  }

  /** Aim at a specific live entity and fire at the given region (convenience for tests/AI). */
  fireAtEntity(entity: EntityId, region: AnatomyRegion): ShotResult {
    const slot = this.entityToSlot.get(entity);
    if (slot === undefined || !this.zombies.isAlive(slot)) {
      throw new Error(`cannot fire at entity ${entity}: not alive`);
    }
    const pos: [number, number, number] = [0, 0, 0];
    this.zombies.getPosition(slot, pos);
    return this.fire(pos[0] - this.playerPos.x, pos[2] - this.playerPos.z, region);
  }

  /** Queue a shot to be resolved by the per-tick combat system (auto-fire path). */
  queueShot(origin: Vec3, dirX: number, dirZ: number, region: AnatomyRegion): void {
    this.pendingShots.push({ origin, dirX, dirZ, region });
  }

  /** Select a target entity (force-promotes it to hero next tier pass, V13). */
  selectTarget(entity: EntityId | null): void {
    this.targetSlot = entity === null ? -1 : this.entityToSlot.get(entity) ?? -1;
  }

  /** Spawn the GATE-0 horde: `count` zombies scattered in room A, all on the shared flow group. */
  spawnHorde(count: number, spawnRadiusMeters: number): EntityId[] {
    const out: EntityId[] = [];
    const c = this.scene.cellCenter(this.scene.spawnCenterCell);
    for (let i = 0; i < count; i++) {
      const { x, z } = this.scatterWalkable(c.x, c.z, spawnRadiusMeters);
      out.push(this.spawnZombie({ x, y: 0, z }, this.pickSpawnArchetype(i)));
    }
    return out;
  }

  /**
   * Deterministic weighted archetype pick (no RNG — hash of the spawn index, V26) so the horde is a MIX:
   * mostly shamblers with rarer runners/crawlers/armored/decayed/burned/bloated. Spawn distribution is
   * content tuning; clamped to the registered archetype count so it never indexes a missing archetype.
   */
  private pickSpawnArchetype(i: number): number {
    // cumulative weights over archetype indices 0..6 (shambler common → bloated rare).
    const CUM = [50, 64, 76, 84, 92, 97, 100];
    const n = this.archetypes.count;
    const h = (i * 2654435761) >>> 0; // Knuth multiplicative hash → spread
    const r = h % 100;
    for (let a = 0; a < CUM.length; a++) {
      if (r < CUM[a]!) return Math.min(a, n - 1);
    }
    return 0;
  }

  /** Spawn one zombie: mint an EntityId, reserve a SoA slot, register a collision agent, map the seam. */
  spawnZombie(position: Vec3, archetypeId = 0): EntityId {
    const entity = this.ids.next<EntityId>('entity');
    this.placeZombie(entity, {
      entity: entity as number,
      archetype: archetypeId,
      x: position.x,
      y: position.y,
      z: position.z,
      heading: 0,
      state: 0,
      health: this.combatCfg.zombieBaseHealth,
      anatomyFlags: 0,
      navGroup: HORDE_NAV_GROUP,
    });
    return entity;
  }

  /**
   * Breach the destructible wall: drive a section cell past its breach threshold. The StructuralModule
   * opens LOCAL nav + collision via the hooks (V5) and emits world events; nothing else rebuilds.
   */
  breachWall(): void {
    // Strike the middle of the wall section (local z = 1) with full strength to guarantee a breach.
    const cell = this.scene.wall.packCell(0, 0, 1);
    const c = this.scene.wall.getCell(cell);
    const amount = c ? c.maxStrength : this.scene.wall.structures.defaultCellStrength;
    this.scene.wall.applyDamage(cell, amount, this.structuralHooks);
  }

  /** Drain both event queues for render/diagnostics consumption. Lifecycle is already applied (V16). */
  pollEvents(): DrainedEvents {
    const world: WorldEvent[] = [];
    const visual: VisualEvent[] = [];
    this.worldEvents.drain((e) => world.push(e));
    this.visualEvents.drain((e) => visual.push(e));
    return { world, visual };
  }

  // ---- persistence (V9 / V23 / V26) — orchestrated by RuntimePersistence ----

  /** Persist the compact delta: structural breaches (lane-S SaveDelta) + id counters + population. */
  async save(): Promise<void> {
    return this.persistence.save();
  }

  /**
   * Reconstruct authoritative state into THIS (fresh) runtime from a saved delta (V9): re-apply the
   * structural breach delta + re-open its LOCAL nav, restore IdFactory counters (so post-load ids never
   * collide — V26), and re-create the live population at their stable EntityIds.
   */
  async loadFrom(): Promise<void> {
    return this.persistence.loadFrom();
  }

  // ---- internals ----

  private registerSystems(): void {
    // everyTick: shared-flow steering + movement integrate (V12/V15/V19).
    this.scheduler.register('movement', { bucket: 'everyTick' }, () => this.horde.stepMovement());
    // everyTick: resolve any queued auto-fire shots (combat resolution slot in the tick).
    this.scheduler.register('combat-resolve', { bucket: 'everyTick' }, () => this.stepQueuedShots());
    // interval: stimulus-driven per-zombie perception + target selection (V14) — never omniscient player
    // coords. Retires decayed stimuli, then each zombie picks its own target (seen player / loudest heard
    // sound / idle). There is NO global sound lure: a localized sound only retargets zombies that hear it.
    this.scheduler.register('perception', { bucket: 'interval', everyTicks: 4 }, (ctx) => this.horde.stepPerception(ctx), 0);
    // interval: tier assignment (V13), phase-offset so it does not share a tick with perception.
    this.scheduler.register('tier', { bucket: 'interval', everyTicks: 4 }, (ctx) => this.horde.stepTiers(ctx), 1);
    // everyTick: zombie melee — a body that has reached the player bites it on its per-archetype cooldown
    // (V14/V16/V17). Registered AFTER perception so on a perception tick the freshly-set Attack state +
    // stimulus are visible to the swing this same tick. Damage routes to the player survival system (T22).
    this.scheduler.register('zombie-attack', { bucket: 'everyTick' }, (ctx) => this.horde.stepAttacks(ctx));
    // interval (coarse): district streaming + objective maintenance + decisive-event resolution (T40).
    this.scheduler.register('district', { bucket: 'interval', everyTicks: DISTRICT_STEP_TICKS }, (ctx) => this.stepDistrict(ctx), 0);
    // interval (coarse): clean up corpses past their configured lifetime (B9/T54). Phase 1 so it never
    // shares a tick with the district step; lifetime is long, so coarse pruning is ample.
    this.scheduler.register('corpses', { bucket: 'interval', everyTicks: DISTRICT_STEP_TICKS }, () => this.corpses.prune(this.absTick()), 1);
    // interval: T108 window attrition — a zombie pressed against a window tears its boards off / smashes the
    // pane over time, eventually opening an entry. Phase 2 so it never shares a tick with perception (0)/tier (1).
    this.scheduler.register('windows', { bucket: 'interval', everyTicks: WINDOW_ATTRITION_TICKS }, () => this.stepWindowAttrition(WINDOW_ATTRITION_TICKS), 2);
  }

  /**
   * T108 zombie window attrition: a window with at least one zombie within `windowZombieReachMeters` accrues
   * `ticks` of attack progress; the WindowSystem tears a board off / smashes an intact pane at its threshold,
   * eventually opening an entry. Authoritative + deterministic (the under-attack set is read from the spatial
   * hash, the same structure the horde steering consults). No-op once a window is already a clear opening.
   */
  private stepWindowAttrition(ticks: number): void {
    const windows = this.windowSystem.list();
    if (windows.length === 0) return;
    const reach = this.structuresCfg.windowZombieReachMeters;
    const underAttack: number[] = [];
    for (const w of windows) {
      if (w.glass !== 'intact' && w.boards === 0) continue; // already an opening — nothing left to attrite
      if (this.spatial.query(w.x, w.z, reach, MOVEMENT_LAYER).length > 0) {
        underAttack.push(this.windowSystem.cellOf(w.cx, w.cy));
      }
    }
    // Snapshot pre-tick glass so we can fire a shard burst for any pane a zombie actually SMASHES this tick
    // (a board-tear is silent visually — only a glass break throws shards).
    const wasIntact = underAttack.map((cell) => this.windowSystem.glassOf(cell) === 'intact');
    this.windowSystem.tick(underAttack, ticks);
    for (let i = 0; i < underAttack.length; i++) {
      const cell = underAttack[i]!;
      if (wasIntact[i] && this.windowSystem.glassOf(cell) === 'smashed') {
        this.emitGlassShatter(cell, this.playerPos.x, this.playerPos.z); // shards toward the camera/player
      }
    }
  }

  /**
   * Coarse M2 step (T40): stream the district around the player (promote/evict abstract sector pops, V13),
   * advance objective timing (auto-complete on reaching the exit while evacuating; fail on countdown
   * elapse), and resolve the decisive horde event at its climax against the live player-shaped state (§G).
   */
  private stepDistrict(ctx: SystemContext): void {
    const now = this.absTick();

    if (this.district) {
      const plan = this.district.update(this.playerPos.x, this.playerPos.z, ctx.tick);
      for (const p of plan.promotions) this.promoteSector(p.sectorId, p.count, p.centerX, p.centerZ);
      for (const e of plan.evictions) this.evictSector(e.sectorId, e.count);
    }

    // Auto-complete the objective when the player reaches an exit cell during evacuation (V1 — the engine
    // recognizes the world condition; no UI click needed for the win).
    if (this.objective.currentPhase === 'evacuating' && this.playerOnExitCell()) {
      this.objective.reachExit();
    }
    this.objective.tick(now);

    // Resolve the climax once the buildup elapses, against whatever the player made of the routes (§G).
    if (this.hordeEvent.shouldResolve(now)) {
      this.hordeEvent.resolve(this.currentEventInput());
    }
  }

  /** Promote up to `count` abstract members of a sector to live sim, scattered near the sector centre. */
  private promoteSector(sectorId: number, count: number, centerX: number, centerZ: number): void {
    const radius = this.combatCfg.gateZeroSpawnRadiusMeters;
    for (let i = 0; i < count; i++) {
      const { x, z } = this.scatterWalkable(centerX, centerZ, radius);
      const entity = this.spawnZombie({ x, y: 0, z });
      const slot = this.entityToSlot.get(entity);
      if (slot !== undefined) this.slotToSector.set(slot, sectorId);
    }
  }

  /** Demote (despawn) up to `count` live members tagged to an evicted sector — folds back to abstract. */
  private evictSector(sectorId: number, count: number): void {
    let removed = 0;
    for (const [slot, sec] of this.slotToSector) {
      if (removed >= count) break;
      if (sec !== sectorId) continue;
      this.despawn(slot); // also clears slotToSector via despawn()
      removed += 1;
    }
  }

  private playerOnExitCell(): boolean {
    const navCellSize = this.scene.navGrid.settings.navCellSize;
    const cx = Math.floor(this.playerPos.x / navCellSize);
    const cy = Math.floor(this.playerPos.z / navCellSize);
    return this.scene.exitCells.some((c) => c.cx === cx && c.cy === cy);
  }

  private stepQueuedShots(): void {
    let shot = this.pendingShots.shift();
    while (shot) {
      this.combat.fire(shot.origin, shot.dirX, shot.dirZ, shot.region, { rollHitLocation: true });
      this.audio.hearEvent('gunfire', shot.origin.x, shot.origin.z, this.clock.tick);
      shot = this.pendingShots.shift();
    }
  }

  private publishSnapshots(): void {
    // Player condition comes from the survival system (T22). Health is scaled back to the count basis
    // (× maxHealth) the HUD expects (0..max); the rest are the survival meters. When the player is dead
    // health is published as 0 — the snapshot itself carries the lethal state (alongside isPlayerDead()).
    const sv = this.playerSurvival.state;
    this.playerGate.push({
      entity: this.playerEntity,
      health: sv.health * this.playerCfg.maxHealth,
      bleeding: sv.bleeding,
      pain: sv.pain,
      hunger: sv.hunger,
      thirst: sv.thirst,
      fatigue: sv.fatigue,
      stress: sv.stress,
      encumbrance: sv.encumbrance,
      stamina: sv.stamina,
      ammoMagazine: this.combat.currentAmmo().magazine,
      ammoReserve: this.combat.currentAmmo().reserve,
    });

    let visibleCount = 0;
    let activeCount = 0;
    let abstractCount = 0;
    let nearest = Number.POSITIVE_INFINITY;
    this.zombies.forEachAlive((slot) => {
      if (this.zombies.getRenderTier(slot) !== SimTier.Abstract) visibleCount += 1;
      const sim = this.zombies.getSimTier(slot);
      if (sim === SimTier.Abstract) abstractCount += 1;
      else activeCount += 1;
      const d = planarDistanceToPlayer(this.zombies, slot, this.playerPos.x, this.playerPos.z);
      if (d < nearest) nearest = d;
    });
    this.hordeGate.push({
      visibleCount,
      activeCount,
      abstractCount,
      nearestThreatMeters: Number.isFinite(nearest) ? nearest : 0,
    });

    // M2 mission status (objective + decisive event preview + district streaming readout), throttled (V11).
    const now = this.absTick();
    const obj = this.objective.snapshot(now);
    const preview = this.hordeEvent.resolvedResult ?? this.evaluateEventNow();
    this.missionGate.push({
      objectivePhase: obj.phase,
      directive: obj.directive,
      partsFound: obj.partsFound,
      partsRequired: obj.partsRequired,
      repairProgressTicks: obj.repairProgressTicks,
      repairRequiredTicks: obj.repairRequiredTicks,
      evacuationTicksRemaining: obj.evacuationTicksRemaining,
      canAdvance: obj.canAdvance,
      eventPhase: this.hordeEvent.currentPhase,
      eventBuildupProgress: this.hordeEvent.buildupProgress(now),
      eventOutcome: this.hordeEvent.resolvedResult ? this.hordeEvent.resolvedResult.outcome : null,
      eventPressure: preview.totalPressure,
      openRoutes: preview.openRouteCount,
      reinforcedRoutes: preview.reinforcedRouteCount,
      activeSectors: this.district ? this.district.activeSectorCount() : 0,
      liveDistrictPop: this.district ? this.district.liveTotal() : 0,
      abstractDistrictPop: this.district ? this.district.abstractTotal() : 0,
    });
  }

  private openBreachedNav(structuralCell: number): void {
    const navCell = this.scene.navCellForStructuralCell(structuralCell);
    // local edit only: clear unblocks the cell, marks ONLY its tile dirty + bumps navRevision (V5),
    // which invalidates the flow-field cache key on the next get.
    this.scene.navGrid.clear(navCell.cx, navCell.cy);
    this.scene.region.addPortal(REGION_ROOM_A, REGION_ROOM_B, this.scene.navIndex(navCell), 1);
  }

  private placeZombie(entity: EntityId, e: Omit<PopulationEntry, 'entity'> & { entity: number }): void {
    const slot = this.zombies.spawn({
      archetype: e.archetype,
      position: [e.x, e.y, e.z],
      heading: e.heading,
      state: e.state,
      health: e.health,
      anatomyFlags: e.anatomyFlags,
      navGroup: e.navGroup,
    });
    this.slotToEntity.set(slot, entity);
    this.entityToSlot.set(entity, slot);
    this.spatial.insert({
      id: slot,
      x: e.x,
      z: e.z,
      radius: this.collision.defaultAgentRadius,
      yMin: 0,
      yMax: this.collision.defaultAgentHeight,
      layers: ZOMBIE_AGENT_LAYERS,
    });
  }

  /**
   * B9/T54 death TRANSITION (combat's onEntityDied): a killed zombie does NOT pop out of existence. Capture
   * a compact CORPSE record from its last authoritative state — transform, archetype, and severed-region
   * flags (dismemberment consequences persist, V17) — BEFORE the sim slot is freed, then recycle the slot
   * (the corpse is cheap state, not an active sim entity). The slot data is still live here: combat writes
   * health/anatomyFlags then calls onEntityDied before any free, so every field reads correctly.
   */
  private killZombie(slot: ZombieSlot): void {
    const entity = this.slotToEntity.get(slot);
    if (entity !== undefined) {
      const pos: [number, number, number] = [0, 0, 0];
      this.zombies.getPosition(slot, pos);
      this.corpses.spawn({
        entity: entity as number,
        x: pos[0],
        y: pos[1],
        z: pos[2],
        heading: this.zombies.getHeading(slot),
        archetype: this.zombies.getArchetype(slot),
        severedFlags: this.zombies.getAnatomyFlags(slot),
        bornTick: this.absTick(),
      });
    }
    this.despawn(slot);
  }

  /** Lifecycle teardown for a dead slot (called by combat on death) — keeps the seam consistent (V26). */
  private despawn(slot: ZombieSlot): void {
    const entity = this.slotToEntity.get(slot);
    this.spatial.remove(slot);
    this.zombies.free(slot);
    this.slotToEntity.delete(slot);
    if (entity !== undefined) this.entityToSlot.delete(entity);
    this.lastDamageTick.delete(slot);
    this.lastAttackTick.delete(slot);
    this.slotToSector.delete(slot);
    if (this.targetSlot === slot) this.targetSlot = -1;
  }

  private scatterWalkable(cx: number, cz: number, radius: number): { x: number; z: number } {
    const safe2 = this.combatCfg.playerSafeSpawnMeters * this.combatCfg.playerSafeSpawnMeters;
    for (let attempt = 0; attempt < MAX_SPAWN_RESAMPLES; attempt++) {
      const x = cx + (this.rand() * 2 - 1) * radius;
      const z = cz + (this.rand() * 2 - 1) * radius;
      // T58/V42: spawn clear of walls (radius-aware) so a body never starts half-embedded.
      if (!isWalkableRadius(this.scene, x, z, this.collision.defaultAgentRadius)) continue;
      // Safe bubble: never spawn a zombie right next to the player at start (resample if inside it).
      const dpx = x - this.playerPos.x;
      const dpz = z - this.playerPos.z;
      if (dpx * dpx + dpz * dpz < safe2) continue;
      return { x, z };
    }
    // No silent fallback: a spawn area that cannot place a body is a content error (V4).
    throw new Error(`could not find a walkable spawn within ${radius}m of (${cx},${cz})`);
  }
}
