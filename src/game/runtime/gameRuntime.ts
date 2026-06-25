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
import { InventorySystem, buildDefaultCatalog, ITEM, rollLoot, consumeEffect, weaponClassForItem } from '@/game/inventory';
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
import { CombatSystem, WEAPON_IDS, type WeaponId, type ShotResult, type DeathImpact } from '@/game/combat';
import {
  buildTestBlock,
  isWalkableRadius,
  nearestWalkablePoint,
  segmentCrossesWall,
  levelNavOf,
  gridWalkableRadius,
  lootableContainerCells,
  rayDistanceToWall,
  PROP_SOLIDITY,
  propBlockedCells,
  DoorSystem,
  WindowSystem,
  windowPlacements,
  resolveHouseVariation,
  REGION_ROOM_A,
  REGION_ROOM_B,
  type TestBlock,
  type LosScene,
  type Vec3,
  type DoorView,
  type WindowView,
  type FurnitureKind,
} from '@/game/scene';
import {
  nearestInteractable,
  hoveredInteractable,
  interactionPrompt,
  highlightBoxFor,
  type NearestInteractable,
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
/** T136: how close (m) the mouse-pointer ground point must be to an interactable's centre to HOVER-select it.
 *  Generous (~1.5 cells) so hovering near an object picks it; beyond it the last selection is HELD (so moving
 *  the cursor to the action menu / loot pane over empty floor never drops focus). */
const INTERACTION_HOVER_RADIUS_METERS = 1.4;
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
  gunCabinet: 'Gun Cabinet',
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
  /** T124/V89 — per-archetype-index move-speed multipliers, built once from the registry; the movement step
   *  scales the shared horde baseline by `[archetype]` so a per-archetype speed takes effect (allocation-free). */
  private readonly archMoveSpeedScale: Float32Array;
  /** T124/V89 — CUMULATIVE per-archetype-index spawn weights + their total, precomputed once so the weighted
   *  spawn pick allocates nothing per spawn (gate-0 + streaming both hit it many times). */
  private readonly archSpawnCum: Float32Array;
  private readonly archSpawnTotal: number;
  /** T124/V89 — monotonic counter feeding the deterministic weighted archetype pick for STREAM-promoted bodies
   *  (district fill). Advances only on a stream spawn, in deterministic streaming order → replay-safe (V26). */
  private streamSpawnSeq = 0;
  /** Session lifecycle store — set to 'dead' once when the player dies (game-over signal for the UI). */
  private readonly session: SessionStore;
  /** Latched so the death transition (set phase 'dead') fires exactly once. */
  private playerDeathHandled = false;

  /** T46 — authoritative door state for the scene's front-door openings (open/closed clears/blocks nav). */
  private readonly doorSystem: DoorSystem;
  /** T108 — authoritative window state (glass/boards). An opening clears its nav cell; boards/intact glass
   *  block it. Seeded from the SAME placements the renderer dresses, so sim + render agree (V26). */
  private readonly windowSystem: WindowSystem;
  /**
   * The scene wrapped with the window-OPENING predicate (V82) — the SHARED structural-raycast scene that knows
   * which window cells are LOS/projectile-transparent RIGHT NOW. Pass THIS (not the bare `scene`) to any of the
   * shared raycast primitives (`rayDistanceToWall`/`hasLineOfSight`/`castVisibilityFan`/`seesWithinFan`) and a
   * sight line passes through an OPEN (glassless / 1-board) window but a CLOSED (2-board / intact) one occludes
   * exactly like a wall — there is NO parallel window-only LOS path. The interaction LOS gate + projectiles
   * consume it (a body / a bullet does not pass an INTACT pane). Built once (no per-call alloc).
   */
  readonly losScene: LosScene;
  /**
   * The scene wrapped with the SEE-THROUGH predicate (V84) — the analogue of `losScene` for what LIGHT + VISION
   * pass through, which is LOOSER: glass is transparent, so an INTACT pane is see-through (only a 2-board
   * boarded-shut window occludes). Pass THIS to the shared raycast for player vision (cone + fog), zombie sight,
   * and the flashlight clamp so they see/light through glassed windows; pass `losScene` for projectiles/reach
   * (which must shatter the pane first). Built once (no per-call alloc).
   */
  readonly sightScene: LosScene;
  /** V100: the scene wrapped with the SOUND window predicate — an open/blasted/glassed window passes sound
   *  HEIGHT-INDEPENDENTLY (unlike `sightScene`, which V87 height-gates), so a gunshot through a window alerts
   *  the zombies OUTSIDE (not only an open door). The perception sound-occlusion LOS uses this. */
  readonly soundScene: LosScene;
  /** V85/V86: per nav-cell OCCLUDER HEIGHT (m) for cells blocked by a SOLID prop — the MAX prop height on that
   *  cell. `sightScene` treats such a cell as TRANSPARENT iff its height is below the CURRENT observer eye height
   *  (`playerEyeHeight()`): a standing player sees over a 1 m fence; a crouched one (lower eye) does not — and is
   *  symmetrically HIDDEN behind it. Walls (not props) are absent here → always occlude. Built once at scene-gen. */
  private readonly propSightHeightByCell = new Map<number, number>();
  /** V86: true while the player holds the sneak/crouch stance (lowers eye height + move speed). Set each frame
   *  from input by `setCrouch` so the eye height is correct even when standing still (not only while moving). */
  private playerCrouching = false;
  /** T127: sim tick of the player's most recent damage hit (-1 = never). The render lane compares it
   *  frame-over-frame to fire the avatar's one-shot hit reaction — written by `damagePlayer`, read-only out (V2). */
  private lastPlayerHitTick = -1;
  /** V87: the window see-through VERTICAL band (world m) — sight passes through a window only when the eye is
   *  within [sill, sill+opening]. A crouched player whose eye drops BELOW the sill is hidden through the window
   *  (and cannot see out of it). Computed once from the wall height × the structures sill/height fractions. */
  private readonly windowSillBottomMeters: number;
  private readonly windowOpeningTopMeters: number;
  /** Resolved structures config (door dims live elsewhere; here: the interaction reach, V4). */
  private readonly structuresCfg = resolveDomain(structuresConfig, REFERENCE_TIER);
  /** Resolved world config — here only for the authored wall height (glass-shatter burst origin, T108). */
  private readonly worldCfg = resolveDomain(worldConfig, REFERENCE_TIER);

  private playerPos: Vec3;
  private playerHeading = 0;
  /** P3 multi-floor: the nav LEVEL the player occupies (0 = ground, default). Stays 0 for a single-storey /
   *  all-outdoors world (no stair links), so every existing movement test + the ground hot path are unchanged.
   *  Climbing a stair (`climbStairs`) transitions it; movement validates against THIS level's nav grid. */
  private playerLevel = 0;
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
    // (a blocked door cell starts closed, an open gap starts open) so sim state matches the geometry. T135: the
    // interactive INTERIOR doors (a subset of doorways) feed the SAME system — they are not building exits, so the
    // exit-count invariant is untouched; a closed one (e.g. the captive room) reads 'closed' from its walled edge.
    this.doorSystem = new DoorSystem(this.scene.navGrid, [...this.scene.exitCells, ...(this.scene.interiorDoors ?? [])]);
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
    // V82: the SHARED window-aware LOS scene. Any consumer that passes `losScene` (instead of the bare `scene`)
    // to the structural raycast sees THROUGH an open window (glassless / 1-board) but NOT a closed (2-board /
    // intact) one. The interaction LOS gate uses it; perception/vision opt in the same way (their task).
    this.losScene = {
      isWalkableWorld: (x, z) => this.scene.isWalkableWorld(x, z),
      navGrid: this.scene.navGrid,
      isWindowOpening: (cx, cy) => this.isWindowOpening(cx, cy),
    };
    // V85/V86: per-cell OCCLUDER HEIGHT for prop-blocked cells — the MAX prop height on each cell. Built ONCE from
    // the scene props + the SAME `fenceMissingChance` the scene-gen used (so the heights match the visible + nav-
    // blocking pickets). A cell shared by a low fence + a tall car keeps the MAX (the car), so it still occludes.
    // Walls are NOT props → absent here → always occlude. The sight test compares this to the LIVE eye height.
    {
      const fenceMiss = this.worldCfg.fenceMissingChance;
      const grid = this.scene.navGrid;
      for (const prop of this.scene.props ?? []) {
        const h = PROP_SOLIDITY[prop.kind].heightMeters;
        for (const c of propBlockedCells(prop, grid.settings.navCellSize, fenceMiss)) {
          if (c.cx < 0 || c.cy < 0 || c.cx >= grid.width || c.cy >= grid.height) continue;
          const idx = grid.index(c.cx, c.cy);
          const prev = this.propSightHeightByCell.get(idx);
          if (prev === undefined || h > prev) this.propSightHeightByCell.set(idx, h);
        }
      }
    }
    // V87: the window see-through vertical band (sill → sill+opening) in world metres.
    {
      const wallH = this.worldCfg.buildingWallHeightMeters;
      this.windowSillBottomMeters = wallH * this.structuresCfg.windowSillFraction;
      this.windowOpeningTopMeters = this.windowSillBottomMeters + wallH * this.structuresCfg.windowHeightFraction;
    }
    // V84/V85/V86: the SEE-THROUGH + SEE-OVER scene — sight + light pass through GLASSED windows (glass is
    // transparent; only a boarded-shut 2-board window occludes) AND OVER any prop SHORTER than the CURRENT eye
    // height (a standing player sees over a 1 m fence; a crouched one does not — and is hidden behind it). Player
    // vision, zombie sight + the flashlight clamp use this; every query is player-referenced, so the one dynamic
    // `playerEyeHeight()` threshold gates both what the player sees AND whether a crouched player is seen.
    {
      const grid = this.scene.navGrid;
      const cs = grid.settings.navCellSize;
      this.sightScene = {
        isWalkableWorld: (x, z) => {
          if (this.scene.isWalkableWorld(x, z)) return true; // genuinely open ground
          const cx = Math.floor(x / cs);
          const cy = Math.floor(z / cs);
          if (cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height) return false;
          const h = this.propSightHeightByCell.get(grid.index(cx, cy));
          return h !== undefined && h < this.playerEyeHeight(); // a prop shorter than the eye → sight passes OVER it
        },
        navGrid: grid,
        isWindowOpening: (cx, cy) => this.isWindowSeeThrough(cx, cy),
      };
    }
    // V100: the SOUND scene — sound passes any open/blasted/glassed window (height-INDEPENDENT, unlike sight's
    // V87 band) so a gunshot through a window alerts the zombies outside, not only an open door. Solid walls /
    // boarded-shut windows still occlude (→ the ×soundWallOcclusion muffle in the perception sound LOS).
    this.soundScene = {
      isWalkableWorld: (x, z) => this.scene.isWalkableWorld(x, z),
      navGrid: this.scene.navGrid,
      isWindowOpening: (cx, cy) => this.isWindowSoundOpen(cx, cy),
    };

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
    // T124/V89: precompute the per-archetype-index move-speed multipliers once (no per-tick lookup of the
    // archetype record) so the movement step scales the shared horde baseline by the archetype's factor.
    this.archMoveSpeedScale = this.archetypes.moveSpeedScales();
    // T124/V89: precompute the CUMULATIVE spawn-weight table once so the deterministic weighted pick allocates
    // nothing per spawn. A roster with no positive weight is a content error (V4 — no silent fallback).
    {
      const weights = this.archetypes.spawnWeights();
      const cum = new Float32Array(weights.length);
      let acc = 0;
      for (let a = 0; a < weights.length; a++) {
        acc += weights[a]!;
        cum[a] = acc;
      }
      if (acc <= 0) throw new Error('zombie spawn weights sum to 0 — no archetype is spawnable (content error, V4)');
      this.archSpawnCum = cum;
      this.archSpawnTotal = acc;
    }
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
      sightScene: this.sightScene, // V83/V84: zombie SIGHT sees THROUGH glassed windows (only a 2-board shut one blocks)
      soundScene: this.soundScene, // V100: SOUND passes open/blasted/glassed windows (height-independent) → alerts outside zombies
      flowCache: this.flowCache,
      tierManager: this.tierManager,
      stimulus: this.stimulus,
      clock: this.clock,
      combatCfg: this.combatCfg,
      perception: this.perception,
      agentRadius: this.collision.defaultAgentRadius,
      playerEntityId: this.playerEntity as number,
      getPlayerPos: () => this.playerPos,
      // P3 multi-floor: hand the horde the scene's level stack + the live player level so a pursuer climbs after
      // the player. Both are inert for a single-storey scene (levelNav absent ⇒ one level; playerLevel stays 0).
      ...(this.scene.levelNav ? { levelNav: this.scene.levelNav } : {}),
      getPlayerLevel: () => this.playerLevel,
      getTargetSlot: () => this.targetSlot,
      lastDamageTick: this.lastDamageTick,
      lastAttackTick: this.lastAttackTick,
      attackOf: (slot) => this.attackProfileOf(slot),
      damagePlayer: (slot, fraction) => this.damagePlayer(slot, fraction),
      // T124/V89: per-archetype move-speed multipliers — the movement step scales the horde baseline per slot.
      moveSpeedScaleByArchetype: this.archMoveSpeedScale,
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
      onEntityDied: (slot, impact) => this.killZombie(slot, impact),
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
    this.basePlayerCapacityKg = this.inventory.capacityOf(playerRef); // T139: base carry cap, before any worn pack
    this.namedContainers.set('player', playerRef);
    // T108/T138: starter loadout — a knife (melee) + a PISTOL (so the equipped pistol is a weapon the player
    // actually CARRIES, and weapon-swap has two classes to cycle out of the box), a hammer + planks for window
    // board-up (the hammer doubles as a breaching tool, V43), plus a bandage + water. Adjust later.
    for (const [item, count] of [[ITEM.KitchenKnife, 1], [ITEM.Pistol, 1], [ITEM.Shotgun, 1], [ITEM.Ammo9mm, 21], [ITEM.ShotgunShells, 12], [ITEM.Bandage, 2], [ITEM.WaterBottle, 1], [ITEM.Hammer, 1], [ITEM.WoodPlank, 6]] as const) {
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
      out.push({ container: name, capacity: this.inventory.capacityOf(ref), weight: this.inventory.containerWeight(ref), slots });
    }
    return out;
  }

  /** T138: USE (consume) one unit of `item` from the PLAYER inventory — eat (reduce hunger), drink (reduce
   *  thirst), or treat a wound (medical: clot bleeding, close a wound, knock infection) — then deduct it. Returns
   *  true only if `item` is a consumable the player actually carries (else no-op). The HUD reflects the new
   *  survival state on the next published snapshot; the caller re-publishes the inventory for the reduced count. */
  useItem(item: number): boolean {
    const eff = consumeEffect(item);
    if (!eff) return false;
    const ref: ContainerRef = { entity: this.playerEntity, container: 'player' };
    if (this.inventory.count(ref, item as ItemId) < 1) return false;
    if (eff.kind === 'eat') this.playerSurvival.eat(eff.amount);
    else if (eff.kind === 'drink') this.playerSurvival.drink(eff.amount);
    else this.playerSurvival.treatWound(eff.amount);
    this.inventory.take(ref, item as ItemId, 1);
    return true;
  }

  /** T139: whether a backpack is currently WORN (granting +capacity). Captured base capacity is the no-pack cap. */
  private equippedBackpack = false;
  private basePlayerCapacityKg = 0;

  /** Equip a found backpack the player CARRIES → raise carry capacity by backpackCapacityBonusKg. No-op if one is
   *  already worn or none is held. The pack stays in the inventory (its weight still counts). */
  equipBackpack(): boolean {
    if (this.equippedBackpack) return false;
    const ref: ContainerRef = { entity: this.playerEntity, container: 'player' };
    if (this.inventory.count(ref, ITEM.Backpack as ItemId) < 1) return false;
    this.equippedBackpack = true;
    this.inventory.setCapacity(ref, this.basePlayerCapacityKg + this.inventory.settings.backpackCapacityBonusKg);
    return true;
  }

  /** Remove the worn backpack → restore base capacity. REFUSED while carried weight exceeds the base (you can't
   *  take the pack off while it's the only thing keeping you under the cap). */
  unequipBackpack(): boolean {
    if (!this.equippedBackpack) return false;
    const ref: ContainerRef = { entity: this.playerEntity, container: 'player' };
    if (this.inventory.containerWeight(ref) > this.basePlayerCapacityKg) return false;
    this.equippedBackpack = false;
    this.inventory.setCapacity(ref, this.basePlayerCapacityKg);
    return true;
  }

  /** True when a backpack is worn (drives the inventory UI equip/remove toggle). */
  isBackpackEquipped(): boolean {
    return this.equippedBackpack;
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

  /** Absolute tick (clock + reload offset) — the SAME basis a corpse `bornTick` is stamped in (`absTick`). The
   *  render lane reads this to age the death-collapse (T122/V87); a pure read, never mutates the sim (V2). */
  get absoluteTick(): number {
    return this.absTick();
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

  /** P3 multi-floor: the nav level the player occupies (0 = ground). Render reads it to lift the camera/body
   *  +storeyHeight and show the occupied storey's cutaway; the horde reads it so a pursuer climbs after you. */
  playerLevelValue(): number {
    return this.playerLevel;
  }

  /**
   * P3 CLIMB: transition the player between storeys via the stair at their current cell. A stair is an explicit
   * action (no auto-transition) so standing on a stair cell never ping-pongs between levels — the simplest model
   * that works (docs/PROCEDURAL-HOUSES.md). When the player's cell (on its current level) carries a stair link,
   * the player moves to the linked cell on the other level (same world XZ); returns true. A single-storey world
   * has no links, so this is always a no-op there (returns false) — keeping the sheltered ground start intact.
   */
  climbStairs(): boolean {
    if (this.isPlayerDead()) return false;
    const nav = levelNavOf(this.scene);
    if (nav.levelCount <= 1) return false;
    const grid = nav.grid(this.playerLevel);
    const { cx, cy } = grid.worldToCell(this.playerPos.x, this.playerPos.z);
    if (cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height) return false;
    const links = nav.stairLinksFrom(this.playerLevel, grid.index(cx, cy));
    const link = links[0];
    if (!link) return false;
    const toGrid = nav.grid(link.toLevel);
    const c = toGrid.coordOf(link.toCell);
    const center = this.scene.cellCenter({ cx: c.cx, cy: c.cy });
    this.playerLevel = link.toLevel;
    this.playerPos = { x: center.x, y: this.playerPos.y, z: center.z };
    return true;
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

  /** P3 multi-floor: the nav level a live zombie occupies (test/diagnostics + render stacking). Throws if not alive. */
  zombieLevel(entity: EntityId): number {
    const slot = this.entityToSlot.get(entity);
    if (slot === undefined || !this.zombies.isAlive(slot)) {
      throw new Error(`cannot read level of entity ${entity}: not alive`);
    }
    return this.zombies.getLevel(slot);
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
   * V86: set the CROUCH (sneak) stance from input each frame. Called every frame (not only while moving) so the
   * eye height is correct while standing still too. Sprint takes precedence — a sprinting player is not crouched.
   */
  setCrouch(crouching: boolean): void {
    this.playerCrouching = crouching;
  }

  /** V86: true while the player holds the crouch/sneak stance (read-only — the render lane reads it to drive the
   *  avatar's crouch-walk/idle animation; additive to the existing `setCrouch`/`playerEyeHeight`). */
  isCrouching(): boolean {
    return this.playerCrouching;
  }

  /** T127: sim tick of the player's most recent damage hit (-1 if never). The render lane compares it
   *  frame-over-frame to trigger the avatar's one-shot hit reaction — a pure read, never mutates the sim (V2). */
  playerLastDamageTick(): number {
    return this.lastPlayerHitTick;
  }

  /** V86: the player's CURRENT eye height (m) — crouched or standing. The dynamic see-over threshold (`sightScene`):
   *  it gates BOTH what the player can see over AND whether a crouched player is hidden behind low cover. */
  playerEyeHeight(): number {
    return this.playerCrouching ? this.perception.crouchEyeHeightMeters : this.perception.eyeHeightMeters;
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
    // V86: stance speed — sprint (fast, gated by stamina) > walk > crouch (slow). Sprint takes precedence over
    // crouch (you cannot sprint crouched), matching the noise precedence below.
    const crouching = !sprinting && sneak;
    const stanceMult = sprinting
      ? this.playerCfg.playerSprintSpeedMultiplier
      : crouching
        ? this.playerCfg.playerCrouchSpeedMultiplier
        : 1;
    const speed = this.playerCfg.moveSpeedMetersPerSecond * stanceMult;
    const stepX = (dirX / len) * speed * dtSeconds;
    const stepZ = (dirZ / len) * speed * dtSeconds;
    const ox = this.playerPos.x;
    const oz = this.playerPos.z;
    const nx = ox + stepX;
    const nz = oz + stepZ;
    // T58/V42: radius-aware so the player body never clips half into a wall. The edge-wall test additionally
    // rejects a step crossing an interior partition between two walkable cells (must use the doorway).
    const r = this.playerCfg.bodyRadiusMeters;
    // P3 multi-floor: validate against the player's CURRENT level grid. Level 0 IS scene.navGrid, so the single
    // -storey path is byte-identical to the old `isWalkableRadius(scene, …)` (gridWalkableRadius wraps the same
    // worldToCell + isBlocked) — every existing movement/sprint/sneak test is unaffected (V26 backward-compat).
    const grid = levelNavOf(this.scene).grid(this.playerLevel);
    let moved = false;
    if (gridWalkableRadius(grid, nx, nz, r) && !segmentCrossesWall(grid, ox, oz, nx, nz)) {
      this.playerPos = { x: nx, y: this.playerPos.y, z: nz };
      moved = true;
    } else if (gridWalkableRadius(grid, nx, oz, r) && !segmentCrossesWall(grid, ox, oz, nx, oz)) {
      // Wall slide: keep the component that stays walkable (standard collision response, not a fallback).
      this.playerPos = { x: nx, y: this.playerPos.y, z: oz };
      moved = true;
    } else if (gridWalkableRadius(grid, ox, nz, r) && !segmentCrossesWall(grid, ox, oz, ox, nz)) {
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
      this.audio.hearEvent('footstep', this.playerPos.x, this.playerPos.z, this.clock.tick, { intensityScale: stanceNoise, level: this.playerLevel });
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
    // Closing a CELL-door onto the player's body would trap them in a solid cell — refuse it and no-op return the
    // current (still-open) access (V42 trap guard). An EDGE-door only walls the cell EDGE; both cells stay
    // walkable, so closing it never traps anyone — the guard MUST NOT block it (that was the "can't close doors"
    // bug: the player stands in the door's own room cell to reach it, so the overlap check always tripped).
    const { cx, cy } = this.scene.navGrid.coordOf(navCell);
    if (!this.doorSystem.isEdgeDoor(navCell) && this.playerOverlapsCell(cx, cy)) {
      return this.doorSystem.accessOf(navCell);
    }
    return this.doorSystem.close(navCell) ? 'closed' : this.doorSystem.accessOf(navCell);
  }

  /** Toggle the door NEAREST the player within interaction reach (the wheel / prompt action). Returns the new
   *  access, or null when no door is in reach. Input-driven (a command), not render-driven (V12). */
  toggleNearestDoor(): 'open' | 'closed' | 'locked' | null {
    const near = this.doorSystem.nearest(this.playerPos.x, this.playerPos.z, this.structuresCfg.interactionRangeMeters);
    if (!near) return null;
    // Closing a CELL-door onto the player traps them in a solid cell (V42) — refuse the close half of the toggle
    // when the body overlaps that cell. An EDGE-door only walls the cell EDGE (both cells stay walkable) so it
    // can never trap them — closing is always safe (the player stands in the door's room cell to reach it, so
    // the overlap guard previously made every edge-door close a no-op — the "can't close doors" bug). Opening is
    // always safe. Return the unchanged access so the prompt stays honest.
    if (
      near.door.access === 'open' &&
      !this.doorSystem.isEdgeDoor(near.navCell) &&
      this.playerOverlapsCell(near.door.cx, near.door.cy)
    ) {
      return near.door.access;
    }
    return this.doorSystem.toggle(near.navCell) ?? null;
  }

  // ---- T108 windows: authoritative glass/board state (commands resolved here, never render-driven) ----

  /** Live window views for the renderer (mesh swap) + interaction resolution. */
  windowViews(): readonly WindowView[] {
    return this.windowSystem.list();
  }

  /**
   * THE shared "is this window cell LOS/projectile-transparent right now?" query (V82). True iff a window sits
   * at nav cell (cx,cy) AND it is a SIGHT/PROJECTILE OPENING — glassless with FEWER than 2 boards (0 or 1). A
   * CLOSED window (2 boards / intact glass) OR a non-window cell returns false (i.e. LOS-OPAQUE — it occludes
   * like a wall). This is the predicate `losScene.isWindowOpening` is built from and the one the shared raycast
   * (`rayDistanceToWall`/`hasLineOfSight`/`castVisibilityFan`/`seesWithinFan`) consults: an OPEN/1-board cell
   * does NOT block the ray, a 2-board/closed cell DOES. Player-vision + zombie-sight become window-aware by
   * passing `runtime.losScene` (or this predicate on their scene) into those same primitives — no parallel path.
   */
  isWindowOpening(cx: number, cy: number, ncx?: number, ncy?: number): boolean {
    // EDGE query (thin-wall house): a window on the seam between (cx,cy) and (ncx,ncy) is what a crossed edge
    // consults — resolve it per-edge so a window edge is distinguished from a solid wall edge on the same cell.
    if (ncx !== undefined && ncy !== undefined) {
      const e = this.windowSystem.edgeCellOf(cx, cy, ncx, ncy);
      if (e >= 0) return this.windowSystem.isOpening(e);
    }
    // CELL query (legacy cell-window): the window IS the blocked cell (cx,cy).
    const nav = this.windowSystem.cellOf(cx, cy);
    return nav >= 0 && this.windowSystem.isOpening(nav);
  }

  /**
   * THE shared "does SIGHT + LIGHT pass through this window cell right now?" query (V84). LOOSER than
   * `isWindowOpening`: GLASS IS TRANSPARENT, so an INTACT pane is see-through (a sight line / light beam passes;
   * only a PROJECTILE needs the glass smashed first). True iff a window sits at (cx,cy) with FEWER than 2 boards,
   * regardless of glass; a CLOSED (2-board) window OR a non-window cell returns false. This is the predicate
   * `sightScene.isWindowOpening` is built from — what player vision (cone + fog), zombie sight, and the
   * flashlight clamp consult, so they see/light THROUGH glassed windows but are blocked by a boarded-shut one.
   */
  isWindowSeeThrough(cx: number, cy: number, ncx?: number, ncy?: number): boolean {
    // (1) is the window see-through BY STATE? (glass-transparent, < 2 boards), height-independent.
    if (!this.windowOpenState(cx, cy, ncx, ncy)) return false;
    // (2) V87 HEIGHT gate — sight passes through the window's vertical OPENING only. The (player-referenced) eye
    // must be within [sill, opening top]; a CROUCHED player whose eye drops below the sill is hidden through the
    // window (and cannot see out of it), a STANDING one is seen. Same dynamic threshold as the see-over (V86).
    const eye = this.playerEyeHeight();
    return eye > this.windowSillBottomMeters && eye < this.windowOpeningTopMeters;
  }

  /** The window OPEN STATE (boards < BOARDS_TO_CLOSE, glass-independent) at (cx,cy) — edge-window resolved first,
   *  else the legacy cell-window. NO height gate. The see-through STATE `isWindowSeeThrough` then height-gates
   *  (V87), and the state SOUND uses directly (V100). */
  private windowOpenState(cx: number, cy: number, ncx?: number, ncy?: number): boolean {
    if (ncx !== undefined && ncy !== undefined) {
      const e = this.windowSystem.edgeCellOf(cx, cy, ncx, ncy);
      if (e >= 0) return this.windowSystem.isSeeThrough(e);
    }
    const nav = this.windowSystem.cellOf(cx, cy);
    return nav >= 0 && this.windowSystem.isSeeThrough(nav);
  }

  /** V100: does SOUND pass through this window cell right now? = the open STATE (boards < 2), HEIGHT-INDEPENDENT
   *  (sound fills the room + passes any open / blasted / glassed window regardless of head height — unlike SIGHT,
   *  which V87 height-gates to the opening band). A boarded-shut (2-board) window muffles. The perception sound
   *  LOS uses this so firing through a blasted window alerts the zombies OUTSIDE, not only an open door. */
  isWindowSoundOpen(cx: number, cy: number, ncx?: number, ncy?: number): boolean {
    return this.windowOpenState(cx, cy, ncx, ncy);
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
   * player's own position moves across the 1-cell wall. No-op unless the window is FULLY OPEN (glass gone AND
   * ZERO boards — even one board blocks bodily entry, V82) AND the far cell is walkable. Climbing is noisy →
   * emits an impact stimulus the horde hears (V14). Returns true on a successful vault.
   */
  climbThroughNearestWindow(): boolean {
    const near = this.nearestWindowInReach();
    if (!near || !this.windowSystem.isFullyOpen(near.navCell)) return false; // intact / boarded — can't climb
    const grid = this.scene.navGrid;
    const cs = grid.settings.navCellSize;
    const wcx = near.window.cx;
    const wcy = near.window.cy;
    let dcx = wcx;
    let dcy = wcy;
    if (near.window.dir) {
      // EDGE-window (thin-wall house): the window sits on the seam between its INNER room cell (wcx,wcy) and
      // the OUTER cell one step in `dir`. Land on whichever of the two the player is NOT in (climb out or in).
      const od = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[near.window.dir] as [number, number];
      const ocx = wcx + od[0];
      const ocy = wcy + od[1];
      const pcx = Math.floor(this.playerPos.x / cs);
      const pcy = Math.floor(this.playerPos.z / cs);
      if (pcx === ocx && pcy === ocy) {
        dcx = wcx;
        dcy = wcy; // player is outside → climb IN to the room cell
      } else {
        dcx = ocx;
        dcy = ocy; // player is inside (or beside) → climb OUT across the edge
      }
    } else {
      // CELL-window (legacy): the window IS a blocked wall cell; its normal is read from the blocked neighbours.
      const blocked = (cx: number, cy: number): boolean =>
        cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height ? true : grid.isBlocked(grid.index(cx, cy));
      const alongX = blocked(wcx - 1, wcy) && blocked(wcx + 1, wcy);
      if (alongX) {
        const side = Math.sign(this.playerPos.z - (wcy + 0.5) * cs) || 1; // which side of the wall the player is on
        dcy = wcy - side; // land on the OPPOSITE side of the window
      } else {
        const side = Math.sign(this.playerPos.x - (wcx + 0.5) * cs) || 1;
        dcx = wcx - side;
      }
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
      // Door leaf orientation: axis 'x' = the wall runs along X → outline thin on Z (rotationY 0); else π/2.
      out.push({ kind: 'door', access: d.access, x: d.x, z: d.z, label: 'Door', orientationRad: d.axis === 'x' ? 0 : Math.PI / 2 });
    }
    // T108: every window, carrying its live glass + board state so the wheel/prompt offer the state-driven
    // verbs (boarded → remove boards, intact → smash glass, opening → climb / board up).
    for (const w of this.windowSystem.list()) {
      out.push({ kind: 'window', glass: w.glass, boards: w.boards, x: w.x, z: w.z, label: 'Window', orientationRad: this.wallRunOrientationRad(w.cx, w.cy) });
    }
    // The destructible §G wall section — anchored at its mid nav cell.
    const wallNav = this.scene.navCellForStructuralCell(this.defaultBreachCell());
    const wallC = this.scene.cellCenter(wallNav);
    const wallCell = this.scene.wall.getCell(this.defaultBreachCell());
    out.push({ kind: 'structure', breached: wallCell?.breached ?? false, x: wallC.x, z: wallC.z, label: 'Wall section', orientationRad: this.wallRunOrientationRad(wallNav.cx, wallNav.cy) });
    // The lootable cupboard(s) at their FIXED authored cells — only nearest when the player is actually beside
    // the cabinet (range-gated by nearestInteractable), never house-wide (the old playerCell anchor bug).
    for (const c of this.worldContainers) {
      out.push({ kind: 'container', x: c.x, z: c.z, label: c.label });
    }
    return out;
  }

  /** The interactables the player can reasonably SEE — `interactables()` minus any blocked by a wall on the
   *  sightline (T60 LOS gate): no looting a cupboard through a wall in the next room. The full `interactables()`
   *  list is unchanged (it answers "what exists / where"); only the player-facing nearest* resolution is gated. */
  private visibleInteractables(): InteractionTargetWorld[] {
    return this.interactables().filter((t) => this.hasLineOfSightTo(t.x, t.z));
  }

  /** True if no STRUCTURAL wall blocks the straight line from the player to (tx,tz) BEFORE reaching it — the
   *  same nav-grid wall raycast the shots (V53) + flashlight (V67) use, but window-aware (V82): the ray passes
   *  through an OPEN window (glassless / 1-board) yet a CLOSED (2-board) window occludes like a wall (no
   *  seeing/looting through it). A one-cell tolerance lets the target's OWN wall cell (door/window/cupboard
   *  against a wall) still count as seen. */
  private hasLineOfSightTo(tx: number, tz: number): boolean {
    const dx = tx - this.playerPos.x;
    const dz = tz - this.playerPos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-3) return true;
    const wallDist = rayDistanceToWall(this.losScene, this.playerPos.x, this.playerPos.z, Math.atan2(dz, dx), dist);
    return wallDist >= dist - this.scene.navGrid.settings.navCellSize;
  }

  /** Physical dims used to SIZE the active-interactable highlight box (typed config + scene cell size, V4). */
  private highlightDims(): HighlightDims {
    const cell = this.scene.navGrid.settings.navCellSize;
    return {
      navCellSize: cell,
      wallHeightMeters: this.worldCfg.buildingWallHeightMeters,
      thinMeters: cell * 0.08, // a leaf/pane is thin on the wall normal (≈0.16 m at a 2 m cell)
      corpseSizeMeters: cell * 0.35, // a low body box (≈0.7 m)
      cupboardWidthMeters: this.structuresCfg.cupboardWidthMeters,
      cupboardDepthMeters: this.structuresCfg.cupboardDepthMeters,
      cupboardHeightMeters: this.structuresCfg.cupboardHeightMeters,
    };
  }

  /** Wall RUN orientation (rad) at nav cell (cx,cy) for a thin door/window/wall outline: 0 = the wall runs
   *  along world X (both ±X neighbours blocked), π/2 = along Z. Mirrors `doorAxis`/the glass-shatter normal. */
  private wallRunOrientationRad(cx: number, cy: number): number {
    const grid = this.scene.navGrid;
    const blocked = (bx: number, by: number): boolean =>
      bx < 0 || by < 0 || bx >= grid.width || by >= grid.height ? true : grid.isBlocked(grid.index(bx, by));
    const alongX = blocked(cx - 1, cy) && blocked(cx + 1, cy);
    return alongX ? 0 : Math.PI / 2;
  }

  /** T136: the live mouse-pointer world point (ground intersection), set by the render input each frame, or null
   *  (no pointer / ray parallel). Drives HOVER selection of which in-reach interactable is the active one. */
  private pointerWorld: { x: number; z: number } | null = null;
  /** T136: nav cell of the last HOVER-picked interactable — HELD while the cursor is over empty world (e.g. on
   *  its way to the action menu / loot pane), so the selection doesn't drop just because the mouse left the
   *  object. −1 = none held. */
  private lastPickedCell = -1;

  /** T136: publish the mouse-pointer world point so the player can HOVER to choose which in-reach interactable is
   *  highlighted/ready (vs always the nearest one). Render input only (V2 — never sim state); null clears it. */
  setPointerWorld(point: { x: number; z: number } | null): void {
    this.pointerWorld = point;
  }

  /** Nav cell a world target sits in (the cell its centre falls in) — stable per interactable, used to HOLD the
   *  hover selection across frames (T136). */
  private cellOfTarget(t: InteractionTargetWorld): number {
    const cs = this.scene.navGrid.settings.navCellSize;
    return this.scene.navGrid.index(Math.floor(t.x / cs), Math.floor(t.z / cs));
  }

  /** The ACTIVE interactable (T60/T136): among the targets in reach, the one the MOUSE is OVER (within
   *  `INTERACTION_HOVER_RADIUS_METERS`) when a pointer world point is published — so the player hovers to choose
   *  WHICH of several adjacent targets is selected. When the cursor is over EMPTY world (near no target — e.g.
   *  travelling to the action menu / loot pane), the last picked target is HELD (so the selection doesn't drop);
   *  if it left reach, fall back to the one nearest the player. All three public interactable readouts route here
   *  so the highlight, the HUD prompt, and the verb wheel always agree on the SAME target. */
  private pickInteractable(): NearestInteractable | null {
    const targets = this.visibleInteractables();
    const range = this.structuresCfg.interactionRangeMeters;
    const px = this.playerPos.x;
    const pz = this.playerPos.z;
    if (this.pointerWorld) {
      const hovered = hoveredInteractable(targets, px, pz, range, this.pointerWorld.x, this.pointerWorld.z, INTERACTION_HOVER_RADIUS_METERS);
      if (hovered) {
        this.lastPickedCell = this.cellOfTarget(hovered.target);
        return hovered;
      }
      // Cursor over empty world → HOLD the last picked target while it stays in reach (so moving the mouse to the
      // menu / pane doesn't drop focus); else fall through to the nearest.
      if (this.lastPickedCell >= 0) {
        const held = targets.find((t) => this.cellOfTarget(t) === this.lastPickedCell);
        if (held) {
          const reach = Math.hypot(held.x - px, held.z - pz);
          if (reach <= range) return { target: held, distanceMeters: reach };
        }
      }
    }
    const near = nearestInteractable(targets, px, pz, range);
    this.lastPickedCell = near ? this.cellOfTarget(near.target) : -1;
    return near;
  }

  /**
   * The ACTIVE interactable in reach as a placed + SIZED highlight box (world centre + axis-aligned bounds +
   * kind), or null when nothing is in reach (T60/V29/T136). The render lane draws ONE colour-coded glowing
   * outline at this box so the player sees WHICH object the "{key} to {action}" prompt refers to — the one under
   * the mouse when hovering, else the nearest. Pure read of the live sim state — polled each frame.
   */
  nearestInteractableHighlight(): InteractionHighlightTarget | null {
    const near = this.pickInteractable();
    if (!near) return null;
    // GENERIC nav-cell resolution (T113/V79): the cell the target's world centre falls in — the SAME index the
    // scene builders tag their interactable meshes with (grid.index(floor(x/cs), floor(z/cs)) == grid.index(cx,cy)
    // for a cell-centred object). The silhouette-glow outline resolves the render mesh(es) by this cell; no
    // per-kind switch. An instanced corpse occupies a cell with no tagged mesh → the view falls back to the box.
    const grid = this.scene.navGrid;
    const cs = grid.settings.navCellSize;
    const navCell = grid.index(Math.floor(near.target.x / cs), Math.floor(near.target.z / cs));
    return { ...highlightBoxFor(near.target, this.highlightDims()), navCell };
  }

  /** The "{key} to {action}" prompt for the NEAREST interactable in reach, or null (T60). Pure read of the
   *  live sim state — the HUD polls it each frame and re-renders only when it changes (V1/V11). */
  nearestInteractionPrompt(key: string): InteractionPrompt | null {
    const near = this.pickInteractable();
    return near ? interactionPrompt(near.target, key) : null;
  }

  /** The ACTIVE interactable target in reach (full state), or null — the wheel resolves its gated verbs. Hover-
   *  picked (T136) so pressing the interact key acts on the SAME target the highlight + prompt point at. */
  nearestInteractableTarget(): InteractionTargetWorld | null {
    const near = this.pickInteractable();
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
    this.lastPlayerHitTick = this.clock.tick; // T127: a fresh hit signal the render lane edge-detects (avatar flinch)
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

  /** The weapon CLASSES the player can swap between — the distinct classes of every weapon ITEM in their
   *  inventory, in stable registry order, with `melee` always available (bare hands / a knife). T138 — swap is
   *  gated to what they CARRY, so finding a shotgun adds it and you never cycle to a weapon you don't have. */
  carriedWeaponClasses(): WeaponId[] {
    const ref: ContainerRef = { entity: this.playerEntity, container: 'player' };
    const set = new Set<WeaponId>(['melee']); // always have your hands/knife
    for (const s of this.inventory.contents(ref)) {
      const cls = weaponClassForItem(s.item);
      if (cls) set.add(cls);
    }
    return WEAPON_IDS.filter((id) => set.has(id));
  }

  /** Cycle the equipped weapon among the CARRIED classes only (T74/T138). */
  cycleWeapon(dir: 1 | -1): void {
    this.combat.cycleWeapon(dir, this.carriedWeaponClasses());
  }

  /** Current ammo + weapon for the HUD (T74). */
  ammoStatus(): { magazine: number; reserve: number; reloading: boolean } {
    return this.combat.currentAmmo();
  }
  currentWeaponId(): string {
    return this.combat.currentWeaponId();
  }

  /** T139: the equipped weapon's pellet fan — drives the render tracer SCATTER (one trail per pellet across the
   *  spread, so a shotgun draws a visible cone, a single-shot weapon one trail). */
  currentWeaponScatter(): { pellets: number; spreadDegrees: number } {
    const w = this.combat.currentWeapon();
    return { pellets: w.pellets, spreadDegrees: w.spreadDegrees };
  }

  /**
   * V53/B20 structure-occlusion query for the combat lane: march the firearm ray in steps <= one nav
   * cell and return the distance (m) to the FIRST projectile-blocking structure cell, or null if the
   * line of fire stays clear to `range`. A cell blocks when it is NOT walkable in the authoritative nav
   * grid — i.e. an intact wall, the un-breached destructible section, a closed/locked door or a boarded
   * panel. A breach or open door clears its nav cell (V5 — openBreachedNav), so it does NOT block. This
   * is the single source of truth shared with line-of-sight (the renderer never decides occlusion).
   */
  /**
   * Resolve a shot crossing the window at `navCell`: true ⇒ the round passes (an OPENING, glassless/smashed
   * <2 boards; or it just SHATTERED an intact unboarded pane on the way through), false ⇒ the round stops
   * (boarded/closed window, a pane that absorbed the hit but held with HP>1, or `navCell < 0` = not a window,
   * i.e. a solid wall). Shared by the cell-window (blocked-cell) path and the EDGE-window (thin-wall) path so
   * both apply the identical glass HP / shatter logic.
   */
  private shotCrossesWindow(navCell: number, wx: number, wz: number, dirX: number, dirZ: number): boolean {
    if (navCell < 0) return false; // not a window — the wall stops the round
    if (this.windowSystem.isOpening(navCell)) return true; // smashed/glassless hole — flies through
    if (this.windowSystem.glassOf(navCell) === 'intact' && (this.windowSystem.boardsOf(navCell) ?? 0) === 0) {
      if (this.windowSystem.applyGlassHit(navCell)) {
        this.emitGlassShatter(navCell, wx + dirX, wz + dirZ); // shards spray along the bullet's travel
        return true; // shattered → shot continues past the opening
      }
      return false; // pane absorbed the hit but did not break (HP > 1) — round stops at the glass
    }
    return false; // a boarded / closed window blocks the round
  }

  private firstProjectileBlockerDistance(
    origin: Readonly<Vec3>,
    dirX: number,
    dirZ: number,
    range: number,
  ): number | null {
    const grid = this.scene.navGrid;
    const cellSize = grid.settings.navCellSize;
    const step = cellSize * this.combatCfg.projectileOcclusionStepRatio; // <= cell size, config-driven (V4)
    const steps = Math.max(1, Math.ceil(range / step));
    const inB = (cx: number, cy: number): boolean => cx >= 0 && cy >= 0 && cx < grid.width && cy < grid.height;
    let pcx = Math.floor(origin.x / cellSize);
    let pcy = Math.floor(origin.z / cellSize);
    for (let i = 1; i <= steps; i++) {
      const d = Math.min(i * step, range);
      const wx = origin.x + dirX * d;
      const wz = origin.z + dirZ * d;
      const cx = Math.floor(wx / cellSize);
      const cy = Math.floor(wz / cellSize);
      // (A) thin EDGE-wall crossing (exterior + interior partitions, and EDGE-windows): a round stops at any
      // walled cell edge it crosses — unless an open/just-shattered EDGE-window on that seam lets it through.
      // Cells stay walkable here, so this is occlusion the blocked-cell test (B) cannot express (thin-wall house).
      if (cx !== pcx || cy !== pcy) {
        if (inB(pcx, pcy) && inB(cx, cy)) {
          const sx = Math.sign(cx - pcx);
          const sy = Math.sign(cy - pcy);
          if (!grid.canStep(pcx, pcy, sx, sy)) {
            const winNav = this.windowSystem.edgeCellOf(pcx, pcy, cx, cy);
            if (!this.shotCrossesWindow(winNav, wx, wz, dirX, dirZ)) return d;
          }
        }
        pcx = cx;
        pcy = cy;
      }
      // (B) blocked CELL (sealed exterior shell, solid props/furniture, legacy CELL-windows, §G — windows are
      // not walk-through openings, V68): the occlusion query resolves cell-window pass-through HERE.
      if (!this.scene.isWalkableWorld(wx, wz)) {
        const navCell = this.windowSystem.cellOf(cx, cy);
        if (this.shotCrossesWindow(navCell, wx, wz, dirX, dirZ)) continue;
        return d;
      }
      if (d >= range) break;
    }
    return null;
  }

  /** Emit a gunshot sound stimulus at the player's current muzzle position into the shared field. */
  private emitGunfire(): void {
    this.audio.hearEvent('gunfire', this.playerPos.x, this.playerPos.z, this.clock.tick, { level: this.playerLevel });
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

  /** T135: spawn the single CAPTIVE zombie the scene authored — sealed in a back room of the player's house
   *  behind a CLOSED interior door, so the opening beat is a contained threat the player must open the door to
   *  face. No-op (returns null) when the scene authored no captive (the rest of the horde is outside). Standard
   *  archetype (a runner sealed in a room would be a brutal first encounter). */
  spawnCaptiveZombie(): EntityId | null {
    const cell = this.scene.captiveZombieCell;
    if (!cell) return null;
    const c = this.scene.cellCenter(cell);
    return this.spawnZombie({ x: c.x, y: 0, z: c.z }, 0);
  }

  /**
   * T124/V89 — DETERMINISTIC weighted archetype pick (no `Math.random`; a hash of the spawn index, V26) so the
   * spawned horde is the STANDARD / BLOATED / RUNNER mix: STANDARD dominant, BLOATED + RUNNER sprinkled. The
   * weights come from the archetype registry (`spawnWeight`, pure config — V4), never a literal table; ecology
   * variants weighted 0 are skipped. The same `i` always yields the same archetype, so a replay reproduces the
   * exact roster (V26). Throws if the roster has no positive weight (a content error — no silent fallback).
   */
  private pickSpawnArchetype(i: number): number {
    const cum = this.archSpawnCum;
    const h = (i * 2654435761) >>> 0; // Knuth multiplicative hash → spread the index across the weight range
    const r = h % this.archSpawnTotal;
    for (let a = 0; a < cum.length; a++) {
      if (r < cum[a]!) return a;
    }
    return cum.length - 1; // unreachable (r < total = last cumulative) — kept total-exhaustive for the type checker
  }

  /**
   * Spawn one zombie: mint an EntityId, reserve a SoA slot, register a collision agent, map the seam. Health is
   * the per-archetype durability (T124/V89 — a BLOATED body spawns with far more health than a RUNNER, so it
   * takes more hits to kill); the default archetype 0 (STANDARD) keeps the baseline `zombieBaseHealth`.
   */
  spawnZombie(position: Vec3, archetypeId = 0): EntityId {
    const entity = this.ids.next<EntityId>('entity');
    // T134/V101: a spawn position that resolves onto a blocked / edge / off-grid cell (a wall, solid furniture,
    // the sealed exterior) can never move — every step clips, so the body stands embedded forever. SNAP it to
    // the nearest radius-walkable cell centre (deterministic, V26). A clear position (the scatterWalkable path,
    // which already resamples to a walkable point) is returned unchanged → no-op for the common spawn path.
    const snapped = nearestWalkablePoint(this.scene, position.x, position.z, this.collision.defaultAgentRadius, this.combatCfg.spawnSnapMaxCells);
    this.placeZombie(entity, {
      entity: entity as number,
      archetype: archetypeId,
      x: snapped.x,
      y: position.y,
      z: snapped.z,
      heading: 0,
      state: 0,
      health: this.archetypes.byIndexOf(archetypeId).durability.health,
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
    const zpos: [number, number, number] = [0, 0, 0];
    const tw = this.scene.navGrid.width;
    for (const w of windows) {
      if (w.glass !== 'intact' && w.boards === 0) continue; // already an opening — nothing left to attrite
      // A window is under attack ONLY when a nearby zombie is trying to get at something BEHIND it — i.e. it is
      // PURSUING a target (targetCell >= 0) that lies BEYOND the window (the window sits between the body and its
      // goal). A zombie merely passing within reach, or one whose goal is elsewhere, does NOT casually knock the
      // glass out (the bug) — and the captive sealed in a back room won't smash its EXTERIOR window on spawn
      // (its target, the player inside, is not beyond that outward-facing pane).
      const nearby = this.spatial.query(w.x, w.z, reach, MOVEMENT_LAYER);
      let attacked = false;
      for (const id of nearby) {
        const slot = id as ZombieSlot;
        const target = this.zombies.getTarget(slot);
        if (target < 0) continue; // no goal → wandering/idle, not pressing the glass
        this.zombies.getPosition(slot, zpos);
        const tc = this.scene.cellCenter({ cx: target % tw, cy: Math.floor(target / tw) });
        // window BETWEEN body and target: (window−body)·(target−window) >= 0 (the path body→window→target runs
        // roughly straight through, so the body must breach the glass to continue toward what it wants).
        if ((w.x - zpos[0]) * (tc.x - w.x) + (w.z - zpos[2]) * (tc.z - w.z) >= 0) {
          attacked = true;
          break;
        }
      }
      if (attacked) underAttack.push(this.windowSystem.cellOf(w.cx, w.cy));
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

  /** Promote up to `count` abstract members of a sector to live sim, scattered near the sector centre.
   *  T124/V89: each promoted body draws its archetype from the SAME deterministic weighted pick as the gate-0
   *  horde (STANDARD dominant, BLOATED + RUNNER sprinkled), keyed by a monotonic stream counter so the streamed
   *  population is a varied mix — not all-STANDARD — while staying replay-deterministic (V26). */
  private promoteSector(sectorId: number, count: number, centerX: number, centerZ: number): void {
    const radius = this.combatCfg.gateZeroSpawnRadiusMeters;
    for (let i = 0; i < count; i++) {
      const { x, z } = this.scatterWalkable(centerX, centerZ, radius);
      const entity = this.spawnZombie({ x, y: 0, z }, this.pickSpawnArchetype(this.streamSpawnSeq++));
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
      this.audio.hearEvent('gunfire', shot.origin.x, shot.origin.z, this.clock.tick, { level: this.playerLevel });
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
      weapon: this.combat.currentWeaponId(),
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
  private killZombie(slot: ZombieSlot, impact?: DeathImpact): void {
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
        // T131/V99: the killing shot's vector → the corpse topples in the push direction. A non-combat death
        // (lifetime expiry) supplies no impact → (0,0,0), i.e. a default heading collapse (the prior behaviour).
        impactDirX: impact?.dirX ?? 0,
        impactDirZ: impact?.dirZ ?? 0,
        impactForce: impact?.force ?? 0,
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
