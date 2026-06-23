// T41 — HordeSimulation: the per-tick horde systems lifted out of GameRuntime so the runtime stays an
// orchestrator, not a god-object. Owns ONLY the shared-flow movement, sound-attraction lure, perception,
// and tier-assignment steps (V12/V13/V14/V15/V19) plus the lure state they mutate. It reads player +
// targeting state through accessors so GameRuntime remains the single authority over those (V1).

import type { FixedClock, SystemContext } from '@/game/core';
import type { StimulusField } from '@/game/stimulus';
import { ZombieState } from '@/game/simulation';
import type { SimulationZombies, TierManager, TierInputs, ZombieSlot } from '@/game/simulation';
import { steer, type FlowFieldCache } from '@/game/navigation';
import {
  CollisionLayer,
  layerMask,
  resolveSeparation,
  type SeparationAgent,
  type SpatialHash,
} from '@/game/navigation/collision';
import type { combatConfig } from '@/config/domains/combat';
import type { perceptionConfig } from '@/config/domains/perception';
import type { ResolvedDomain } from '@/config/types';
import { isWalkableRadius, hasLineOfSight, type TestBlock, type Vec3 } from '@/game/scene';

const MOVEMENT_PROFILE = 'zombie-walk';
const MOVEMENT_MASK = layerMask(CollisionLayer.Movement);

/** Strips readonly so pooled penetration-resolution agents can be re-filled in place across ticks. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * True when a target at offset (dx,dz) lies within a vision cone of half-angle `fovHalf` centred on
 * `heading` (V14 — zombies see a forward cone, not 360°). `fovHalf >= π` = omnidirectional.
 */
export function withinCone(dx: number, dz: number, heading: number, fovHalf: number): boolean {
  if (fovHalf >= Math.PI) return true;
  const diff = Math.atan2(dz, dx) - heading;
  return Math.abs(Math.atan2(Math.sin(diff), Math.cos(diff))) <= fovHalf;
}

/** Planar (XZ) distance from a zombie slot to the player — shared by the horde steps and snapshots. */
export function planarDistanceToPlayer(
  zombies: SimulationZombies,
  slot: ZombieSlot,
  px: number,
  pz: number,
): number {
  const pos: [number, number, number] = [0, 0, 0];
  zombies.getPosition(slot, pos);
  return Math.hypot(pos[0] - px, pos[2] - pz);
}

export interface HordeSimulationDeps {
  readonly zombies: SimulationZombies;
  readonly spatial: SpatialHash;
  readonly scene: TestBlock;
  readonly flowCache: FlowFieldCache;
  readonly tierManager: TierManager;
  readonly stimulus: StimulusField;
  readonly clock: FixedClock;
  readonly combatCfg: ResolvedDomain<typeof combatConfig>;
  readonly perception: ResolvedDomain<typeof perceptionConfig>;
  /** Agent circle-proxy radius for radius-aware static collision (T58/V42 — no clipping into walls). */
  readonly agentRadius: number;
  /** Player entity id stamped into the SoA stimulus column when a zombie senses the player in range (V14). */
  readonly playerEntityId: number;
  /** Live player position (GameRuntime owns it; the horde only reads it — never the omniscient coord, V14). */
  readonly getPlayerPos: () => Readonly<Vec3>;
  /** Live selected target slot (-1 = none); promotes that slot to hero next tier pass (V13). */
  readonly getTargetSlot: () => ZombieSlot;
  /** Tick of last damage per slot, owned by GameRuntime's combat callbacks; read here for tier recency. */
  readonly lastDamageTick: Map<ZombieSlot, number>;
}

/**
 * The per-tick horde systems. GameRuntime registers thin wrappers that delegate here; all behavior
 * (steering, lure, perception, tiering) lives in this one cohesive unit.
 */
export class HordeSimulation {
  /** Sound-attraction lure: while active the WHOLE horde reroutes to the loudest perceived sound (V15). */
  private soundLureCell: number | null = null;
  private soundLureUntilTick = -1;
  /** True when ANY zombie currently senses the player by sight (set by stepPerception). Sight overrides a
   *  stale sound lure (V14/B16) — you can't walk past a horde that sees you while it chases an old gunshot. */
  private playerVisibleToHorde = false;

  // Reused per-tick work buffers for the penetration-resolution pass — pooled so the everyTick step
  // allocates nothing in steady state (keeps the crowd-scale benchmark's p99 free of GC spikes).
  private readonly resolvePool: SeparationAgent[] = [];
  private readonly resolveBySlot = new Map<number, SeparationAgent>();
  private readonly resolveNeighbors: SeparationAgent[] = [];

  constructor(private readonly d: HordeSimulationDeps) {}

  /** everyTick: shared-flow steering + movement integrate (V12/V15/V19). */
  stepMovement(): void {
    const { zombies, spatial, scene, flowCache, combatCfg, clock, agentRadius } = this.d;
    const targetCell = this.flowTargetCell();
    const field = flowCache.get(scene.navGrid, targetCell, MOVEMENT_PROFILE);
    const dt = clock.tickSeconds;
    const speed = combatCfg.hordeMoveSpeed;
    const sep = combatCfg.steerSeparationMeters;
    const flowWeight = combatCfg.steerFlowWeight;
    const pos: [number, number, number] = [0, 0, 0];
    // Arrival: once within this radius of the target, STOP steering so the body settles at the ring instead
    // of piling into the target and fighting the separation pass each tick (the jitter, V19/V35).
    const tw = scene.navGrid.width;
    const target = scene.cellCenter({ cx: targetCell % tw, cy: Math.floor(targetCell / tw) });
    const arriveR2 = combatCfg.hordeArriveRadiusMeters * combatCfg.hordeArriveRadiusMeters;

    zombies.forEachAlive((slot) => {
      if (zombies.getNavGroup(slot) < 0) return;
      zombies.getPosition(slot, pos);
      const adx = target.x - pos[0];
      const adz = target.z - pos[2];
      if (adx * adx + adz * adz <= arriveR2) {
        zombies.setVelocity(slot, 0, 0, 0); // arrived — hold position, let separation settle (no jiggle)
        return;
      }
      const ids = spatial.query(pos[0], pos[2], sep, MOVEMENT_MASK, { exclude: slot });
      const neighbors = ids.map((id) => {
        const a = spatial.get(id);
        return { dx: a.x - pos[0], dz: a.z - pos[2] };
      });
      const { dirX, dirZ } = steer(field, { x: pos[0], z: pos[2], neighbors, separation: sep, flowWeight });
      if (dirX === 0 && dirZ === 0) {
        zombies.setVelocity(slot, 0, 0, 0);
        return;
      }
      const nx = pos[0] + dirX * speed * dt;
      const nz = pos[2] + dirZ * speed * dt;
      // T58/V42: radius-aware static collision + wall-slide so a body never clips half into a wall.
      let mx = pos[0];
      let mz = pos[2];
      let moved = false;
      if (isWalkableRadius(scene, nx, nz, agentRadius)) {
        mx = nx;
        mz = nz;
        moved = true;
      } else if (isWalkableRadius(scene, nx, pos[2], agentRadius)) {
        mx = nx;
        moved = true;
      } else if (isWalkableRadius(scene, pos[0], nz, agentRadius)) {
        mz = nz;
        moved = true;
      }
      if (moved) {
        zombies.setPosition(slot, mx, pos[1], mz);
        zombies.setHeading(slot, Math.atan2(dirZ, dirX));
        zombies.setVelocity(slot, dirX * speed, 0, dirZ * speed);
        spatial.update(slot, mx, mz);
      } else {
        zombies.setVelocity(slot, 0, 0, 0);
      }
    });

    // B4 / V19: the steering above only SOFT-separates. Resolve any remaining hard interpenetration
    // among the individually-visible tiers so bodies never visibly overlap. Abstract/low stays exempt.
    this.resolveCrowdOverlap();
  }

  /**
   * Hard min-spacing penetration resolution (B4 / V19). Runs AFTER the movement integrate: gathers the
   * visible-tier agents (sim tier <= configured max), pushes overlapping pairs apart to at least their
   * min spacing via a pure relaxation pass, keeps the walkable check authoritative (no wall push-through),
   * then writes the corrected positions back to the store and re-buckets the moved agents in the spatial
   * hash so subsequent queries stay correct. Abstract-tier agents are exempt (compressed horde may overlap).
   */
  private resolveCrowdOverlap(): void {
    const { zombies, spatial } = this.d;
    const { minSpacingScale, separationIterations, maxResolvedSimTier, broadPhaseCellSize } =
      spatial.settings;
    if (separationIterations <= 0) return;

    // Build the resolvable set (visible tiers only) into the pooled buffers. The SeparationAgent x/z
    // are mutated in place by the resolver; abstract/low tier (sim tier > max) is excluded so it stays
    // free to compress/overlap (V19).
    const pool = this.resolvePool;
    const bySlot = this.resolveBySlot;
    bySlot.clear();
    let n = 0;
    zombies.forEachAlive((slot) => {
      if (zombies.getSimTier(slot) > maxResolvedSimTier) return;
      const a = spatial.get(slot);
      let agent = pool[n] as Mutable<SeparationAgent> | undefined;
      if (!agent) {
        agent = { id: slot, x: a.x, z: a.z, radius: a.radius };
        pool[n] = agent;
      } else {
        agent.id = slot;
        agent.x = a.x;
        agent.z = a.z;
        agent.radius = a.radius;
      }
      bySlot.set(slot, agent);
      n += 1;
    });
    pool.length = n; // present only the agents filled this tick (no allocation; pooled objects reused)
    if (n < 2) return;

    // Neighbour candidates come from the broad-phase hash (bounded, V19), filtered to the resolvable set.
    // The query radius covers the largest possible min spacing within a cell window; live distances are
    // recomputed from the mutated agent positions inside the resolver. The neighbour scratch array is
    // reused — the resolver fully consumes it before requesting the next agent's neighbours.
    const queryRadius = minSpacingScale * 2 * spatial.settings.defaultAgentRadius + broadPhaseCellSize;
    const scratch = this.resolveNeighbors;
    const neighborsOf = (agent: SeparationAgent): SeparationAgent[] => {
      const ids = spatial.query(agent.x, agent.z, queryRadius, MOVEMENT_MASK, { exclude: agent.id });
      scratch.length = 0;
      for (const id of ids) {
        const neighbor = bySlot.get(id);
        if (neighbor) scratch.push(neighbor);
      }
      return scratch;
    };

    const moved = resolveSeparation(
      pool,
      neighborsOf,
      (x, z) => this.d.scene.isWalkableWorld(x, z),
      { iterations: separationIterations, minSpacingScale },
    );

    const pos: [number, number, number] = [0, 0, 0];
    for (const slot of moved) {
      const agent = bySlot.get(slot)!;
      zombies.getPosition(slot, pos);
      zombies.setPosition(slot, agent.x, pos[1], agent.z);
      spatial.update(slot, agent.x, agent.z);
    }
  }

  /**
   * Sound attraction (V14/V15): retire decayed stimuli, then read the loudest SOUND reaching the horde's
   * cluster from the shared field — NOT the player coordinate directly. If one is heard, lure the whole
   * horde to its source for the configured investigate window; the lure expires back to tracking the
   * player. Because every agent shares ONE flow field, retargeting reroutes the entire horde at once.
   */
  stepSound(ctx: SystemContext): void {
    const { stimulus, scene, perception } = this.d;
    stimulus.update(ctx.tick);
    const here = scene.cellCenter(scene.spawnCenterCell);
    const hits = stimulus.query(here.x, here.z, ctx.tick);
    let bestX = 0;
    let bestZ = 0;
    let bestIntensity = 0;
    for (const h of hits) {
      if (h.stimulus.kind !== 'sound') continue;
      // V28: structure muffles sound. A sound whose path to the horde is blocked by a wall reaches it at a
      // reduced intensity — a breach/open door restores the loud path (V5/V47).
      const occluded = !hasLineOfSight(scene, h.stimulus.x, h.stimulus.z, here.x, here.z);
      const intensity = occluded ? h.intensity * perception.soundWallOcclusion : h.intensity;
      if (intensity > bestIntensity) {
        bestIntensity = intensity;
        bestX = h.stimulus.x;
        bestZ = h.stimulus.z;
      }
    }
    if (bestIntensity > 0 && scene.isWalkableWorld(bestX, bestZ)) {
      const c = scene.navGrid.worldToCell(bestX, bestZ);
      this.soundLureCell = scene.navGrid.index(c.cx, c.cy);
      this.soundLureUntilTick = ctx.tick + perception.investigateTicks;
    }
  }

  /** The shared flow-field target this tick: the active sound lure if any, else the live player cell. */
  flowTargetCell(): number {
    const { scene, clock, getPlayerPos } = this.d;
    // B16/V14: sight beats a stale sound lure. The lure only steers the horde while NO zombie can see the
    // player; the moment any does, the shared field retargets onto the player (drop the lure).
    if (!this.playerVisibleToHorde && this.soundLureCell !== null && clock.tick <= this.soundLureUntilTick) {
      return this.soundLureCell;
    }
    this.soundLureCell = null;
    const p = getPlayerPos();
    const c = scene.navGrid.worldToCell(p.x, p.z);
    return scene.navGrid.index(c.cx, c.cy);
  }

  /** interval: stimulus-driven perception (V14) — a zombie senses the player only within sight range. */
  stepPerception(): void {
    const { zombies, perception, playerEntityId, getPlayerPos, scene } = this.d;
    const p = getPlayerPos();
    const sight = perception.sightRange;
    // V14: a zombie SEES the player only within its forward vision cone, not 360°. fovHalf = full angle/2.
    const fovHalf = (perception.fieldOfViewDegrees * Math.PI) / 360;
    const coned = fovHalf < Math.PI;
    const attackRange = perception.attackRangeMeters;
    // Investigating a heard sound = the horde is lured + not yet seeing the player.
    const lured = this.soundLureCell !== null && this.d.clock.tick <= this.soundLureUntilTick;
    const pos: [number, number, number] = [0, 0, 0];
    let seen = false;
    zombies.forEachAlive((slot) => {
      zombies.getPosition(slot, pos);
      const dx = p.x - pos[0];
      const dz = p.z - pos[2];
      const dist = Math.hypot(dx, dz);
      let inSight = dist <= sight;
      if (inSight && coned) inSight = withinCone(dx, dz, zombies.getHeading(slot), fovHalf);
      // V47: walls / closed doors block sight — no seeing the player through solid structure.
      if (inSight) inSight = hasLineOfSight(scene, pos[0], pos[2], p.x, p.z);
      zombies.setStimulus(slot, inSight ? playerEntityId : -1);
      // V20: drive the FSM state so behaviour + the debug indicator reflect what the zombie is doing.
      let state: number;
      if (inSight) state = dist <= attackRange ? ZombieState.Attack : ZombieState.Pursue;
      else if (lured) state = ZombieState.Wander; // searching/investigating a heard sound
      else state = ZombieState.Idle;
      zombies.setState(slot, state);
      if (inSight) seen = true;
    });
    // B16/V14: cache whether the horde sees the player so flowTargetCell can let sight override a stale lure.
    this.playerVisibleToHorde = seen;
  }

  /** interval: tier assignment (V13), phase-offset so it never shares a tick with perception. */
  stepTiers(ctx: SystemContext): void {
    const { zombies, perception, combatCfg, tierManager, getPlayerPos, getTargetSlot, lastDamageTick } = this.d;
    const p = getPlayerPos();
    const target = getTargetSlot();
    const sight = perception.sightRange;
    const window = combatCfg.recentDamageWindowTicks;
    zombies.forEachAlive((slot) => {
      const dist = planarDistanceToPlayer(zombies, slot, p.x, p.z);
      const visible = dist <= sight;
      const damagedAt = lastDamageTick.get(slot);
      const recentDamage = damagedAt !== undefined && ctx.tick - damagedAt <= window;
      const inputs: TierInputs = {
        distance: dist,
        visible,
        threat: visible ? perception.visibleThreatWeight : 0,
        cameraImportance: 0,
        targeted: slot === target,
        recentDamage,
        currentAttack: false,
        perfBudget: combatCfg.perfBudget,
      };
      tierManager.update(zombies, slot, inputs);
    });
  }
}
