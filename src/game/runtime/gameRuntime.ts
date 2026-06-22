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
} from '@/game/core';
import {
  SimulationZombies,
  TierManager,
  SimTier,
  type TierInputs,
  type ZombieSlot,
} from '@/game/simulation';
import { FlowFieldCache, steer } from '@/game/navigation';
import { CollisionLayer, layerMask, SpatialHash } from '@/game/navigation/collision';
import { type StructuralHooks } from '@/game/destruction';
import {
  captureSaveDelta,
  readSaveDelta,
  writeSaveDelta,
  SaveCompatError,
  type ModuleDelta,
  type PartitionKey,
  type PersistenceAdapter,
} from '@/game/persistence';
import { resolveDomain } from '@/config/registry';
import { weaponsConfig } from '@/config/domains/weapons';
import { combatConfig } from '@/config/domains/combat';
import { playerConfig } from '@/config/domains/player';
import { perceptionConfig } from '@/config/domains/perception';
import { collisionConfig } from '@/config/domains/collision';
import { gameConfig } from '@/config/domains/game';
import { timeConfig } from '@/config/domains/time';
import type { QualityTier } from '@/config/types';
import { CombatSystem, type ShotResult } from '@/game/combat';
import {
  buildTestBlock,
  REGION_ROOM_A,
  REGION_ROOM_B,
  type TestBlock,
  type Vec3,
} from '@/game/scene';
import {
  RUNTIME_SAVE_KEY,
  RUNTIME_SAVE_SCHEMA_VERSION,
  type PopulationEntry,
  type RuntimeSave,
} from './saveRecord';
import {
  createPlayerSnapshotGate,
  createHordeSnapshotGate,
  playerViewStore,
  mapViewStore,
  type PlayerViewStore,
  type MapViewStore,
} from '@/stores';
import type { Now } from '@/stores';

const REFERENCE_TIER: QualityTier = 'desktop-high';
const HORDE_NAV_GROUP = 0;
const MOVEMENT_PROFILE = 'zombie-walk';
const MOVEMENT_MASK = layerMask(CollisionLayer.Movement);
const ZOMBIE_AGENT_LAYERS = layerMask(CollisionLayer.Movement, CollisionLayer.Projectile, CollisionLayer.Sight);
const MAX_SPAWN_RESAMPLES = 32;

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
  /** Deterministic scatter seed for the initial horde spawn (V26). */
  readonly scatterSeed?: number;
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
  readonly playerEntity: EntityId;

  private readonly adapter: PersistenceAdapter;
  private readonly partition: PartitionKey;
  private readonly worldEvents: RingQueue<WorldEvent>;
  private readonly visualEvents: RingQueue<VisualEvent>;
  private readonly weapons = resolveDomain(weaponsConfig, REFERENCE_TIER);
  private readonly combatCfg = resolveDomain(combatConfig, REFERENCE_TIER);
  private readonly playerCfg = resolveDomain(playerConfig, REFERENCE_TIER);
  private readonly perception = resolveDomain(perceptionConfig, REFERENCE_TIER);
  private readonly collision = resolveDomain(collisionConfig, REFERENCE_TIER);

  private readonly slotToEntity = new Map<ZombieSlot, EntityId>();
  private readonly entityToSlot = new Map<EntityId, ZombieSlot>();
  private readonly lastDamageTick = new Map<ZombieSlot, number>();
  private readonly pendingShots: { origin: Vec3; dirX: number; dirZ: number; region: AnatomyRegion }[] = [];
  private targetSlot: ZombieSlot = -1;

  private readonly rand: () => number;
  private readonly structuralHooks: StructuralHooks;

  private elapsedMs = 0;
  private readonly playerGate: ReturnType<typeof createPlayerSnapshotGate>;
  private readonly hordeGate: ReturnType<typeof createHordeSnapshotGate>;

  private playerPos: Vec3;
  private playerHealth: number;

  constructor(opts: GameRuntimeOptions) {
    this.tier = opts.tier ?? REFERENCE_TIER;
    this.scene = opts.scene ?? buildTestBlock();
    this.adapter = opts.adapter;
    this.partition = opts.partition ?? { district: 0, sector: 0 };
    this.rand = mulberry32(opts.scatterSeed ?? 1);

    const time = resolveDomain(timeConfig, this.tier);
    this.clock = new FixedClock({
      tickHz: time.tickHz,
      maxFrameSeconds: time.maxFrameSeconds,
      maxCatchUpTicks: time.maxCatchUpTicks,
    });

    this.ids = new IdFactory();
    this.zombies = new SimulationZombies(); // capacity from zombies config (V4)
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
    this.playerHealth = this.playerCfg.startHealth;

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
      onEntityDied: (slot) => this.despawn(slot),
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

    const playerNow: Now = () => this.elapsedMs;
    this.playerGate = createPlayerSnapshotGate(opts.playerStore ?? playerViewStore, this.tier, playerNow);
    this.hordeGate = createHordeSnapshotGate(opts.mapStore ?? mapViewStore, this.tier, playerNow);

    this.registerSystems();
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
   * Advance the authoritative sim by `dtSeconds` of real time: integrate the fixed clock, run every due
   * scheduled system per tick, then publish throttled view snapshots (V12/V1/V11). Returns ticks run.
   */
  update(dtSeconds: number): number {
    const ticks = this.clock.advance(dtSeconds);
    this.elapsedMs += dtSeconds * 1000;
    const ctx: SystemContext = { tick: this.clock.tick, tickSeconds: this.clock.tickSeconds };
    for (let i = 0; i < ticks; i++) {
      this.scheduler.runTick(ctx);
    }
    this.publishSnapshots();
    return ticks;
  }

  /** Fire one firearm shot immediately (deterministic). Combat is resolved authoritatively now. */
  fire(dirX: number, dirZ: number, region: AnatomyRegion): ShotResult {
    return this.combat.fire(this.playerPos, dirX, dirZ, region);
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
      out.push(this.spawnZombie({ x, y: 0, z }));
    }
    return out;
  }

  /** Spawn one zombie: mint an EntityId, reserve a SoA slot, register a collision agent, map the seam. */
  spawnZombie(position: Vec3): EntityId {
    const entity = this.ids.next<EntityId>('entity');
    this.placeZombie(entity, {
      entity: entity as number,
      archetype: 0,
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

  // ---- persistence (V9 / V23 / V26) ----

  /** Persist the compact delta: structural breaches (lane-S SaveDelta) + id counters + population. */
  async save(): Promise<void> {
    const moduleDeltas: ModuleDelta[] = [
      { module: this.scene.moduleId as number, cells: this.scene.wall.modificationDelta() },
    ];
    const delta = captureSaveDelta({
      worldVersion: this.scene.worldVersion,
      partition: this.partition,
      capturedAtTick: this.clock.tick,
      modules: moduleDeltas,
    });
    await writeSaveDelta(this.adapter, delta);

    const population: PopulationEntry[] = [];
    const pos: [number, number, number] = [0, 0, 0];
    this.zombies.forEachAlive((slot) => {
      this.zombies.getPosition(slot, pos);
      population.push({
        entity: this.entityOf(slot) as number,
        archetype: this.zombies.getArchetype(slot),
        x: pos[0],
        y: pos[1],
        z: pos[2],
        heading: this.zombies.getHeading(slot),
        state: this.zombies.getState(slot),
        health: this.zombies.getHealth(slot),
        anatomyFlags: this.zombies.getAnatomyFlags(slot),
        navGroup: this.zombies.getNavGroup(slot),
      });
    });
    const record: RuntimeSave = {
      schemaVersion: RUNTIME_SAVE_SCHEMA_VERSION,
      worldVersion: this.scene.worldVersion,
      capturedAtTick: this.clock.tick,
      idCounters: this.ids.snapshot(),
      population,
    };
    await this.adapter.put(this.partition, RUNTIME_SAVE_KEY, record);
  }

  /**
   * Reconstruct authoritative state into THIS (fresh) runtime from a saved delta (V9): re-apply the
   * structural breach delta + re-open its LOCAL nav, restore IdFactory counters (so post-load ids never
   * collide — V26), and re-create the live population at their stable EntityIds.
   */
  async loadFrom(): Promise<void> {
    if (this.zombies.count > 0) throw new Error('loadFrom must run on a fresh runtime');

    const delta = await readSaveDelta(this.adapter, this.partition, this.scene.worldVersion); // validates V23
    if (delta) {
      for (const m of delta.modules) {
        if (m.module === (this.scene.moduleId as number)) {
          this.scene.wall.applyDeltaSnapshot(m.cells);
        }
      }
      // applyDeltaSnapshot does not run hooks; re-open LOCAL nav for every breached cell so the route
      // is reconstructed exactly (same breach state feeds nav — V18).
      for (let z = 0; z < this.scene.wall.sizeZ; z++) {
        const cell = this.scene.wall.packCell(0, 0, z);
        if (this.scene.wall.isBreached(cell)) this.openBreachedNav(cell);
      }
    }

    const record = await this.adapter.get<RuntimeSave>(this.partition, RUNTIME_SAVE_KEY);
    if (record) {
      if (record.schemaVersion !== RUNTIME_SAVE_SCHEMA_VERSION) {
        throw new SaveCompatError(`runtime save schema ${record.schemaVersion} != ${RUNTIME_SAVE_SCHEMA_VERSION}`);
      }
      if (record.worldVersion !== this.scene.worldVersion) {
        throw new SaveCompatError(`runtime save world '${record.worldVersion}' != '${this.scene.worldVersion}'`);
      }
      // Restore counters first; population is recreated at saved ids (no minting), so the next mint
      // is guaranteed beyond every restored id.
      this.ids.restore(record.idCounters);
      for (const e of record.population) {
        this.placeZombie(e.entity as EntityId, e);
      }
    }
  }

  // ---- internals ----

  private registerSystems(): void {
    // everyTick: shared-flow steering + movement integrate (V12/V15/V19).
    this.scheduler.register('movement', { bucket: 'everyTick' }, () => this.stepMovement());
    // everyTick: resolve any queued auto-fire shots (combat resolution slot in the tick).
    this.scheduler.register('combat-resolve', { bucket: 'everyTick' }, () => this.stepQueuedShots());
    // interval: stimulus-driven perception (V14) — never omniscient player coords.
    this.scheduler.register('perception', { bucket: 'interval', everyTicks: 4 }, () => this.stepPerception(), 0);
    // interval: tier assignment (V13), phase-offset so it does not share a tick with perception.
    this.scheduler.register('tier', { bucket: 'interval', everyTicks: 4 }, (ctx) => this.stepTiers(ctx), 1);
  }

  private stepMovement(): void {
    const targetCell = this.scene.navIndex(this.scene.playerCell);
    const field = this.flowCache.get(this.scene.navGrid, targetCell, MOVEMENT_PROFILE);
    const dt = this.clock.tickSeconds;
    const speed = this.combatCfg.hordeMoveSpeed;
    const sep = this.combatCfg.steerSeparationMeters;
    const flowWeight = this.combatCfg.steerFlowWeight;
    const pos: [number, number, number] = [0, 0, 0];

    this.zombies.forEachAlive((slot) => {
      if (this.zombies.getNavGroup(slot) < 0) return;
      this.zombies.getPosition(slot, pos);
      const ids = this.spatial.query(pos[0], pos[2], sep, MOVEMENT_MASK, { exclude: slot });
      const neighbors = ids.map((id) => {
        const a = this.spatial.get(id);
        return { dx: a.x - pos[0], dz: a.z - pos[2] };
      });
      const { dirX, dirZ } = steer(field, { x: pos[0], z: pos[2], neighbors, separation: sep, flowWeight });
      if (dirX === 0 && dirZ === 0) {
        this.zombies.setVelocity(slot, 0, 0, 0);
        return;
      }
      const nx = pos[0] + dirX * speed * dt;
      const nz = pos[2] + dirZ * speed * dt;
      if (this.scene.isWalkableWorld(nx, nz)) {
        this.zombies.setPosition(slot, nx, pos[1], nz);
        this.zombies.setHeading(slot, Math.atan2(dirZ, dirX));
        this.zombies.setVelocity(slot, dirX * speed, 0, dirZ * speed);
        this.spatial.update(slot, nx, nz);
      } else {
        this.zombies.setVelocity(slot, 0, 0, 0);
      }
    });
  }

  private stepQueuedShots(): void {
    let shot = this.pendingShots.shift();
    while (shot) {
      this.combat.fire(shot.origin, shot.dirX, shot.dirZ, shot.region);
      shot = this.pendingShots.shift();
    }
  }

  private stepPerception(): void {
    // V14: a zombie only gains a stimulus when the player is within its sensing range — not omniscient.
    const sight = this.perception.sightRange;
    this.zombies.forEachAlive((slot) => {
      const d = this.distanceToPlayer(slot);
      this.zombies.setStimulus(slot, d <= sight ? (this.playerEntity as number) : -1);
    });
  }

  private stepTiers(ctx: SystemContext): void {
    const sight = this.perception.sightRange;
    const window = this.combatCfg.recentDamageWindowTicks;
    this.zombies.forEachAlive((slot) => {
      const d = this.distanceToPlayer(slot);
      const visible = d <= sight;
      const damagedAt = this.lastDamageTick.get(slot);
      const recentDamage = damagedAt !== undefined && ctx.tick - damagedAt <= window;
      const inputs: TierInputs = {
        distance: d,
        visible,
        threat: visible ? this.perception.visibleThreatWeight : 0,
        cameraImportance: 0,
        targeted: slot === this.targetSlot,
        recentDamage,
        currentAttack: false,
        perfBudget: this.combatCfg.perfBudget,
      };
      this.tierManager.update(this.zombies, slot, inputs);
    });
  }

  private publishSnapshots(): void {
    this.playerGate.push({
      entity: this.playerEntity,
      health: this.playerHealth,
      bleeding: 0,
      pain: 0,
      hunger: this.playerCfg.initialHunger,
      thirst: this.playerCfg.initialThirst,
      fatigue: this.playerCfg.initialFatigue,
      stress: this.playerCfg.initialStress,
      encumbrance: 0,
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
      const d = this.distanceToPlayer(slot);
      if (d < nearest) nearest = d;
    });
    this.hordeGate.push({
      visibleCount,
      activeCount,
      abstractCount,
      nearestThreatMeters: Number.isFinite(nearest) ? nearest : 0,
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

  /** Lifecycle teardown for a dead slot (called by combat on death) — keeps the seam consistent (V26). */
  private despawn(slot: ZombieSlot): void {
    const entity = this.slotToEntity.get(slot);
    this.spatial.remove(slot);
    this.zombies.free(slot);
    this.slotToEntity.delete(slot);
    if (entity !== undefined) this.entityToSlot.delete(entity);
    this.lastDamageTick.delete(slot);
    if (this.targetSlot === slot) this.targetSlot = -1;
  }

  private distanceToPlayer(slot: ZombieSlot): number {
    const pos: [number, number, number] = [0, 0, 0];
    this.zombies.getPosition(slot, pos);
    return Math.hypot(pos[0] - this.playerPos.x, pos[2] - this.playerPos.z);
  }

  private scatterWalkable(cx: number, cz: number, radius: number): { x: number; z: number } {
    for (let attempt = 0; attempt < MAX_SPAWN_RESAMPLES; attempt++) {
      const x = cx + (this.rand() * 2 - 1) * radius;
      const z = cz + (this.rand() * 2 - 1) * radius;
      if (this.scene.isWalkableWorld(x, z)) return { x, z };
    }
    // No silent fallback: a spawn area that cannot place a body is a content error (V4).
    throw new Error(`could not find a walkable spawn within ${radius}m of (${cx},${cz})`);
  }
}
