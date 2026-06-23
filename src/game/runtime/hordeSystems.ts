// T41 — HordeSimulation: the per-tick horde systems lifted out of GameRuntime so the runtime stays an
// orchestrator, not a god-object. Owns the per-zombie target selection (V14), the grouped multi-field
// movement (V15), perception, and tier-assignment steps (V12/V13/V14/V15/V19). It reads player + targeting
// state through accessors so GameRuntime remains the single authority over those (V1).
//
// V14 sound model: sound is LOCALIZED perception, NOT a global flow retarget. Each zombie picks ITS OWN
// target every perception tick: the PLAYER if it currently SEES it (sight range/cone + LOS), else the
// LOUDEST sound it HEARS right now (stimulus.query at its own position; overlapping sounds → loudest-
// reaching-this-zombie wins), else no target (idle/wander). Zombies that chose the same target cell SHARE
// one cached flow field; a NW gunshot and an SE bottle thus produce two fields pulling two groups in two
// directions. The number of distinct fields per tick is capped (perception.maxSimultaneousFlowFields) so
// cost stays bounded; targets outside the cap fall back to idle/wander (B16: no global single-target lure).

import type { FixedClock, SystemContext } from '@/game/core';
import type { StimulusField } from '@/game/stimulus';
import { ZombieState, SimTier } from '@/game/simulation';
import type { SimulationZombies, TierManager, TierInputs, ZombieSlot } from '@/game/simulation';
import { steer, type FlowField, type FlowFieldCache } from '@/game/navigation';
import {
  CollisionLayer,
  layerMask,
  resolveSeparation,
  type SeparationAgent,
  type SpatialHash,
} from '@/game/navigation/collision';
import { limbConsequences, type ConsequenceConfig } from '@/game/combat';
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
  /** Tick of each slot's last melee swing at the player (cooldown gate). Owned by GameRuntime so it is
   *  cleared on despawn — a recycled slot must not inherit a stale cooldown (V26). */
  readonly lastAttackTick: Map<ZombieSlot, number>;
  /**
   * Resolve a slot's attack parameters from its archetype (V14 — stimulus-driven, the runtime owns the
   * slot<->archetype seam + the damage scale). `damageFraction` is a normalized fraction of player max
   * health; `cooldownTicks` is the per-archetype cadence in fixed ticks; `rangeMeters` is melee reach.
   */
  readonly attackOf: (slot: ZombieSlot) => { damageFraction: number; cooldownTicks: number; rangeMeters: number };
  /** Apply a melee hit to the player (routed through GameRuntime -> the player survival system, T22). */
  readonly damagePlayer: (slot: ZombieSlot, damageFraction: number) => void;
}

/**
 * The per-tick horde systems. GameRuntime registers thin wrappers that delegate here; all behavior
 * (steering, lure, perception, tiering) lives in this one cohesive unit.
 */
export class HordeSimulation {
  // ---- per-zombie target selection + grouped multi-field movement (V14/V15) ----
  // The chosen target CELL per zombie lives in the SoA `target` column (reset to -1 on spawn, so a recycled
  // slot never inherits a stale target — V26). `targetExpiry` is the tick until which a zombie keeps
  // investigating its last-known target after the stimulus fades; it is gated by target >= 0 (which the SoA
  // resets), so a stale expiry on a recycled slot is harmless. Sized to capacity, allocated once.
  private readonly targetExpiry: Int32Array;
  // Reused per-tick grouping buffers — cleared (not reallocated) each movement tick so the everyTick path
  // allocates nothing in steady state (keeps the crowd-avenue benchmark p99 free of GC spikes).
  private readonly targetCounts = new Map<number, number>();
  private readonly activeFieldByCell = new Map<number, FlowField>();
  private readonly activeCenterX = new Map<number, number>();
  private readonly activeCenterZ = new Map<number, number>();
  private readonly distinctTargets: number[] = [];
  /** Orders distinct target cells by popularity (most-pursued first) with a deterministic cell-index
   *  tie-break (V12/V26), so the capped flow-field budget is assigned the same way every replay. Bound once
   *  in the constructor (references targetCounts) so sorting allocates no closure per tick. */
  private readonly compareByPopularity: (a: number, b: number) => number;

  // Reused per-tick work buffers for the penetration-resolution pass — pooled so the everyTick step
  // allocates nothing in steady state (keeps the crowd-scale benchmark's p99 free of GC spikes).
  private readonly resolvePool: SeparationAgent[] = [];
  private readonly resolveBySlot = new Map<number, SeparationAgent>();
  private readonly resolveNeighbors: SeparationAgent[] = [];
  // Reused buffer for the nearest-first limb-tier budget cap in stepTiers (pooled — tiers run every 4 ticks).
  private readonly tierCand: { slot: ZombieSlot; dist: number; visible: boolean; recentDamage: boolean; mandatory: boolean }[] = [];

  /** Missing-limb consequence tunables (V17), read straight from the combat domain — no literals. */
  private readonly consequence: ConsequenceConfig;

  constructor(private readonly d: HordeSimulationDeps) {
    this.consequence = {
      armLossLocomotionPenalty: d.combatCfg.armLossLocomotionPenalty,
      legLossLocomotionPenalty: d.combatCfg.legLossLocomotionPenalty,
      armLossThreatPenalty: d.combatCfg.armLossThreatPenalty,
      legsLostToCrawl: d.combatCfg.legsLostToCrawl,
    };
    this.targetExpiry = new Int32Array(d.zombies.capacity).fill(-1);
    this.compareByPopularity = (a, b) => {
      const ca = this.targetCounts.get(a) ?? 0;
      const cb = this.targetCounts.get(b) ?? 0;
      if (cb !== ca) return cb - ca; // more-pursued target first
      return a - b; // deterministic tie-break: lower cell index first
    };
  }

  /**
   * everyTick: grouped multi-field steering + movement integrate (V12/V15/V19). Each zombie follows the
   * flow field for ITS OWN chosen target cell (set by perception, V14) — there is NO single global field.
   * Zombies sharing a target cell share one cached field; the number of distinct fields is capped this tick
   * (perception.maxSimultaneousFlowFields). A zombie with no target, or whose target lost the capped budget,
   * holds position (idle/wander) — firing never reroutes a zombie that did not hear the shot.
   */
  stepMovement(): void {
    const { zombies, spatial, scene, combatCfg, clock, agentRadius } = this.d;
    const dt = clock.tickSeconds;
    const speed = combatCfg.hordeMoveSpeed;
    const sep = combatCfg.steerSeparationMeters;
    const flowWeight = combatCfg.steerFlowWeight;
    const pos: [number, number, number] = [0, 0, 0];
    // Arrival: once within this radius of the target, STOP steering so the body settles at the ring instead
    // of piling into the target and fighting the separation pass each tick (the jitter, V19/V35).
    const arriveR2 = combatCfg.hordeArriveRadiusMeters * combatCfg.hordeArriveRadiusMeters;

    // Group zombies by target cell and resolve the capped set of shared flow fields for this tick (V15).
    this.buildActiveFields();
    const fieldByCell = this.activeFieldByCell;

    zombies.forEachAlive((slot) => {
      if (zombies.getNavGroup(slot) < 0) return;

      // V17/T57: a body in stagger is interrupted — it neither moves nor attacks until the timer expires.
      // The stateTimer (seconds, written by combat) ticks DOWN here every tick; on expiry the body leaves
      // stagger (-> Idle) so perception re-acquires it next pass. Nothing else clobbers the transient state.
      if (zombies.getState(slot) === ZombieState.Stagger) {
        const remaining = zombies.getStateTimer(slot) - dt;
        if (remaining > 0) {
          zombies.setStateTimer(slot, remaining);
        } else {
          zombies.setStateTimer(slot, 0);
          zombies.setState(slot, ZombieState.Idle);
        }
        zombies.setVelocity(slot, 0, 0, 0);
        return;
      }

      // Each zombie steers toward the field for the target cell perception chose for it (V14). A target of
      // -1 (idle) or one that did not win the capped field budget has no field → the body holds position.
      const targetCell = zombies.getTarget(slot);
      const field = targetCell >= 0 ? fieldByCell.get(targetCell) : undefined;
      if (!field) {
        zombies.setVelocity(slot, 0, 0, 0);
        return;
      }

      zombies.getPosition(slot, pos);
      const adx = this.activeCenterX.get(targetCell)! - pos[0];
      const adz = this.activeCenterZ.get(targetCell)! - pos[2];
      if (adx * adx + adz * adz <= arriveR2) {
        zombies.setVelocity(slot, 0, 0, 0); // arrived — hold position, let separation settle (no jiggle)
        return;
      }
      // V17: missing limbs slow locomotion (legs dominate — a legless body crawls). The common case
      // (flags === 0) skips the consequence math entirely so the steady-state hot path stays cheap.
      let moveScale = 1;
      const flags = zombies.getAnatomyFlags(slot);
      if (flags !== 0) {
        const cons = limbConsequences(flags, this.consequence);
        moveScale = cons.locomotionScale;
        zombies.setAnimState(slot, cons.posture); // posture is derived from sever state (V17) — surface for render
        if (moveScale <= 0) {
          zombies.setVelocity(slot, 0, 0, 0); // no functional legs/arms left to translate the body
          return;
        }
      }
      const effSpeed = speed * moveScale;
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
      const nx = pos[0] + dirX * effSpeed * dt;
      const nz = pos[2] + dirZ * effSpeed * dt;
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
        zombies.setVelocity(slot, dirX * effSpeed, 0, dirZ * effSpeed);
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
   * Group the live horde by chosen target cell and resolve the capped set of shared flow fields for this
   * tick (V14/V15). Counts how many zombies pursue each distinct target cell, then assigns the bounded
   * field budget (perception.maxSimultaneousFlowFields) to the most-pursued cells (deterministic tie-break
   * by cell index, V12/V26). For each winning cell it fetches the cached field (a cache hit after the first
   * compute — cheap with the heap-based Dijkstra) and precomputes the cell centre once for the arrival test.
   * Cells outside the budget — and cells that became blocked since perception — get no field, so their
   * zombies idle/wander. All buffers are cleared, not reallocated, so a steady-state tick allocates nothing.
   */
  private buildActiveFields(): void {
    const { zombies, scene, flowCache, perception } = this.d;
    const navGrid = scene.navGrid;
    const tw = navGrid.width;
    const counts = this.targetCounts;
    const distinct = this.distinctTargets;
    counts.clear();
    distinct.length = 0;
    zombies.forEachAlive((slot) => {
      if (zombies.getNavGroup(slot) < 0) return;
      const tc = zombies.getTarget(slot);
      if (tc < 0) return;
      const prev = counts.get(tc);
      if (prev === undefined) {
        counts.set(tc, 1);
        distinct.push(tc);
      } else {
        counts.set(tc, prev + 1);
      }
    });

    this.activeFieldByCell.clear();
    this.activeCenterX.clear();
    this.activeCenterZ.clear();
    if (distinct.length === 0) return;

    distinct.sort(this.compareByPopularity);
    const limit = Math.min(perception.maxSimultaneousFlowFields, distinct.length);
    for (let i = 0; i < limit; i++) {
      const cell = distinct[i]!;
      // A field can only be built toward a walkable cell; guard the invariant rather than let the field
      // constructor throw if a nav edit blocked the cell between perception and this movement tick (V5).
      if (navGrid.isBlocked(cell)) continue;
      this.activeFieldByCell.set(cell, flowCache.get(navGrid, cell, MOVEMENT_PROFILE));
      const center = scene.cellCenter({ cx: cell % tw, cy: Math.floor(cell / tw) });
      this.activeCenterX.set(cell, center.x);
      this.activeCenterZ.set(cell, center.z);
    }
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
   * interval: stimulus-driven per-zombie perception + target selection (V14). Retires decayed stimuli, then
   * for EACH zombie picks its own target this tick (no global lure): the PLAYER if it currently sees it
   * (sight range + forward cone + line-of-sight, V47), else the LOUDEST sound it hears at its own position
   * (overlapping sounds → loudest-reaching-this-zombie wins, V28 wall occlusion applied), else — if it still
   * has a live target within the investigate window — its last-known target (investigating), else none
   * (idle). The chosen target CELL is written to the SoA `target` column (read by stepMovement to follow the
   * matching field) and the player-entity stimulus column is set ONLY when the player is actually seen (the
   * melee gate, V14). Sight beats sound beats investigate beats idle. Runs on a fixed cadence (V12/V26).
   */
  stepPerception(ctx: SystemContext): void {
    const { zombies, perception, playerEntityId, getPlayerPos, scene, stimulus } = this.d;
    stimulus.update(ctx.tick); // retire fully-decayed stimuli so each hearing query sees only live sources
    const p = getPlayerPos();
    const navGrid = scene.navGrid;
    const sight = perception.sightRange;
    // V14: a zombie SEES the player only within its forward vision cone, not 360°. fovHalf = full angle/2.
    const fovHalf = (perception.fieldOfViewDegrees * Math.PI) / 360;
    const coned = fovHalf < Math.PI;
    const attackRange = perception.attackRangeMeters;
    const investigate = perception.investigateTicks;
    // The player's cell — the target a zombie that SEES the player pursues. Out-of-bounds player ⇒ -1.
    const pc = navGrid.worldToCell(p.x, p.z);
    const playerCell =
      pc.cx >= 0 && pc.cy >= 0 && pc.cx < navGrid.width && pc.cy < navGrid.height
        ? navGrid.index(pc.cx, pc.cy)
        : -1;
    const pos: [number, number, number] = [0, 0, 0];
    zombies.forEachAlive((slot) => {
      zombies.getPosition(slot, pos);
      const dx = p.x - pos[0];
      const dz = p.z - pos[2];
      const dist = Math.hypot(dx, dz);
      let inSight = dist <= sight;
      if (inSight && coned) inSight = withinCone(dx, dz, zombies.getHeading(slot), fovHalf);
      // V47: walls / closed doors block sight — no seeing the player through solid structure.
      if (inSight) inSight = hasLineOfSight(scene, pos[0], pos[2], p.x, p.z);
      const sensesPlayer = inSight && playerCell >= 0;

      // V14 per-zombie target: a freshly sensed player or sound (re)arms the investigate window; with
      // nothing sensed now the zombie keeps its last-known target only until that window lapses, then idles.
      let target: number;
      let acquired = false;
      if (sensesPlayer) {
        target = playerCell;
        acquired = true;
      } else {
        const heard = this.loudestHeardSoundCell(pos[0], pos[2], ctx.tick);
        if (heard >= 0) {
          target = heard;
          acquired = true;
        } else if (zombies.getTarget(slot) >= 0 && ctx.tick <= this.targetExpiry[slot]!) {
          target = zombies.getTarget(slot); // investigating last-known origin until the window lapses
        } else {
          target = -1;
        }
      }
      zombies.setTarget(slot, target);
      if (acquired) this.targetExpiry[slot] = ctx.tick + investigate;
      // The melee gate keys off the player-entity stimulus column — set ONLY when truly seen (V14).
      zombies.setStimulus(slot, sensesPlayer ? playerEntityId : -1);

      // V17/T57: never clobber a transient combat-set stagger — it ticks down in stepMovement and the
      // body re-acquires its FSM state once it expires. Sensing (the columns above) still updates.
      if (zombies.getState(slot) === ZombieState.Stagger && zombies.getStateTimer(slot) > 0) return;
      // V20: drive the FSM state so behaviour + the debug indicator reflect what the zombie is doing.
      let state: number;
      if (sensesPlayer) state = dist <= attackRange ? ZombieState.Attack : ZombieState.Pursue;
      else if (target >= 0) state = ZombieState.Wander; // pursuing/investigating a heard sound
      else state = ZombieState.Idle;
      zombies.setState(slot, state);
    });
  }

  /**
   * The cell of the LOUDEST sound stimulus actually reaching (x,z) right now, or -1 if nothing audible above
   * the alert threshold (V14). Overlapping sounds resolve to the loudest-reaching-this-point; V28 wall
   * occlusion muffles a sound whose path here is blocked by structure. A source on a blocked cell is skipped
   * (no field can be built to it). Ties break to the lower cell index (deterministic, V12/V26).
   */
  private loudestHeardSoundCell(x: number, z: number, tick: number): number {
    const { stimulus, scene, perception } = this.d;
    const navGrid = scene.navGrid;
    const threshold = perception.alertIntensityThreshold;
    const hits = stimulus.query(x, z, tick);
    let bestCell = -1;
    let bestIntensity = -1;
    for (const h of hits) {
      if (h.stimulus.kind !== 'sound') continue;
      const occluded = !hasLineOfSight(scene, h.stimulus.x, h.stimulus.z, x, z);
      const intensity = occluded ? h.intensity * perception.soundWallOcclusion : h.intensity;
      if (intensity < threshold) continue;
      const c = navGrid.worldToCell(h.stimulus.x, h.stimulus.z);
      if (c.cx < 0 || c.cy < 0 || c.cx >= navGrid.width || c.cy >= navGrid.height) continue;
      const cell = navGrid.index(c.cx, c.cy);
      if (navGrid.isBlocked(cell)) continue;
      if (intensity > bestIntensity || (intensity === bestIntensity && cell < bestCell)) {
        bestIntensity = intensity;
        bestCell = cell;
      }
    }
    return bestCell;
  }

  /**
   * everyTick combat reach (V14/V16/V17): a zombie that has ACTUALLY reached the player bites it on a
   * per-archetype cooldown, routing damage to the player through the runtime (T22 survival). It attacks
   * ONLY the player it senses (its stimulus column = the player entity, set by perception) — never via an
   * omniscient coordinate (V14). A staggered body is interrupted (its state is no longer Attack, so it is
   * skipped). Missing arms scale the bite down (reduced reach/threat); both arms gone = no bite (V17).
   */
  stepAttacks(ctx: SystemContext): void {
    const { zombies, playerEntityId, getPlayerPos, attackOf, damagePlayer, lastAttackTick } = this.d;
    const p = getPlayerPos();
    zombies.forEachAlive((slot) => {
      if (zombies.getState(slot) !== ZombieState.Attack) return; // staggered/pursuing/idle do not bite
      if (zombies.getStimulus(slot) !== playerEntityId) return; // only the player it actually senses (V14)
      let threatScale = 1;
      const flags = zombies.getAnatomyFlags(slot);
      if (flags !== 0) {
        const cons = limbConsequences(flags, this.consequence);
        if (!cons.canAttack) return; // both arms severed — cannot land a standing melee (V17)
        threatScale = cons.threatScale;
      }
      const profile = attackOf(slot);
      // Re-verify the body is still within its melee reach NOW (it may have been pushed off the ring). This
      // is the reached body's own distance — the same player read perception uses, not a cheat (V14).
      if (planarDistanceToPlayer(zombies, slot, p.x, p.z) > profile.rangeMeters) return;
      const last = lastAttackTick.get(slot);
      if (last !== undefined && ctx.tick - last < profile.cooldownTicks) return; // still on cooldown
      lastAttackTick.set(slot, ctx.tick);
      damagePlayer(slot, profile.damageFraction * threatScale);
    });
  }

  /** interval: tier assignment (V13), phase-offset so it never shares a tick with perception. */
  stepTiers(ctx: SystemContext): void {
    const { zombies, perception, combatCfg, tierManager, getPlayerPos, getTargetSlot, lastDamageTick } = this.d;
    const p = getPlayerPos();
    const target = getTargetSlot();
    const sight = perception.sightRange;
    const window = combatCfg.recentDamageWindowTicks;
    const budget = combatCfg.heroActivePromotionBudget;

    // Pass 1: gather candidates (pooled buffer, no per-tick alloc). `mandatory` = targeted/recently-damaged →
    // always hero for combat correctness (V22), exempt from the budget cap.
    const cand = this.tierCand;
    let n = 0;
    zombies.forEachAlive((slot) => {
      const dist = planarDistanceToPlayer(zombies, slot, p.x, p.z);
      const damagedAt = lastDamageTick.get(slot);
      const recentDamage = damagedAt !== undefined && ctx.tick - damagedAt <= window;
      let c = cand[n];
      if (!c) { c = { slot, dist: 0, visible: false, recentDamage: false, mandatory: false }; cand[n] = c; }
      c.slot = slot;
      c.dist = dist;
      c.visible = dist <= sight;
      c.recentDamage = recentDamage;
      c.mandatory = slot === target || recentDamage;
      n += 1;
    });
    cand.length = n;

    // Rank by distance: only the NEAREST `budget` may hold a limb tier (≤1) so the render limb pool shows the
    // CLOSEST figures (no slot-order inversion where far zombies are limbed + close ones boxed). V13/V22.
    cand.sort((a, b) => a.dist - b.dist);

    for (let i = 0; i < n; i++) {
      const c = cand[i]!;
      const inputs: TierInputs = {
        distance: c.dist,
        visible: c.visible,
        threat: c.visible ? perception.visibleThreatWeight : 0,
        cameraImportance: 0,
        targeted: c.slot === target,
        recentDamage: c.recentDamage,
        currentAttack: false,
        perfBudget: combatCfg.perfBudget,
      };
      let a = tierManager.assign(inputs);
      // Budget cap: a non-mandatory zombie outside the nearest-`budget` set may NOT keep a limb tier — clamp
      // it to the box tier so the limb pool only ever holds the nearest N (mandatory/combat zombies bypass).
      if (!c.mandatory && a.simTier <= SimTier.ActiveCrowd && i >= budget) {
        a = { simTier: SimTier.VisibleHorde, renderTier: c.visible ? SimTier.VisibleHorde : SimTier.Abstract };
      }
      tierManager.apply(zombies, c.slot, a);
    }
  }
}
