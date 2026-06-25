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
import {
  steer,
  combineSteer,
  wallClearanceBias,
  cornerBiasedWallWeight,
  resolveLevelMove,
  LevelNav,
  LevelFlowFieldCache,
  type FlowField,
  type FlowFieldCache,
  type LevelFlowField,
} from '@/game/navigation';
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
import {
  isWalkableRadius,
  hasLineOfSight,
  gridHasLineOfSight,
  segmentCrossesWall,
  levelNavOf,
  gridWalkableRadius,
  type TestBlock,
  type LosScene,
  type Vec3,
} from '@/game/scene';

const MOVEMENT_PROFILE = 'zombie-walk';
const MOVEMENT_MASK = layerMask(CollisionLayer.Movement);

/**
 * Rotate the `current` heading toward `target` by AT MOST `maxStep` radians, the shortest way around. The body's
 * FACING is driven by its goal direction (the separation-free flow / a beeline to a sealed target) and clamped to
 * this turn rate so it never SNAPS or flip-flops — a blocked, jostled zombie smoothly keeps looking at the spot it
 * wants (e.g. the player behind a window) instead of jerking 180° with the neighbour repulsion. Pure (V26).
 */
function turnToward(current: number, target: number, maxStep: number): number {
  let diff = target - current;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // shortest signed delta in (-π, π]
  if (diff > maxStep) diff = maxStep;
  else if (diff < -maxStep) diff = -maxStep;
  return current + diff;
}

/**
 * Deterministic STUCK-ESCAPE fan (T134/V101): when the desired flow step AND both axis-slides are blocked, the
 * body rotates its desired heading by these signed angle offsets — tried in this FIXED order (nearest the
 * desired heading first, alternating sides) — and takes the first that yields a radius-walkable, non-wall-
 * crossing step. This wall-FOLLOWS the body around a corner / out of a pocket instead of freezing it against
 * the wall. Precomputed cos/sin → no per-tick trig or allocation (V24); a fixed small set (V26).
 */
const ESCAPE_FAN_DEGREES: readonly number[] = [30, -30, 60, -60, 90, -90];
export const STUCK_ESCAPE_FAN: readonly { cos: number; sin: number }[] = ESCAPE_FAN_DEGREES.map((deg) => {
  const a = (deg * Math.PI) / 180;
  return { cos: Math.cos(a), sin: Math.sin(a) };
});

/** T137 idle-wander retry fan: the chosen amble heading FIRST (0°), then ever-wider offsets up to a full
 *  reverse, so a wanderer that ambles into a wall/furniture re-aims to the first clear direction instead of
 *  standing pinned for the whole interval (the "captive barely moves behind furniture" case). Fixed order (V26). */
const WANDER_FAN_DEGREES: readonly number[] = [0, 45, -45, 90, -90, 135, -135, 180];
const WANDER_FAN: readonly { cos: number; sin: number }[] = WANDER_FAN_DEGREES.map((deg) => {
  const a = (deg * Math.PI) / 180;
  return { cos: Math.cos(a), sin: Math.sin(a) };
});

/**
 * PURE stuck-escape selection (T134/V101): rotate the desired unit heading (dirX,dirZ) by each fan offset in
 * order and return the FIRST rotated heading the `isClear(edx,edz)` predicate accepts, or null if every fan
 * direction is blocked (a genuine dead-end → the caller stops). The rotation preserves unit length (cos/sin of
 * a unit vector), so the chosen heading drives the same locomotion speed. Deterministic — pure fn of the inputs
 * + the fixed fan (V26). Exposed for unit testing the selection against a blocked fan.
 */
export function selectEscapeDir(
  dirX: number,
  dirZ: number,
  isClear: (edx: number, edz: number) => boolean,
): { dirX: number; dirZ: number } | null {
  for (let i = 0; i < STUCK_ESCAPE_FAN.length; i++) {
    const r = STUCK_ESCAPE_FAN[i]!;
    const edx = dirX * r.cos - dirZ * r.sin;
    const edz = dirX * r.sin + dirZ * r.cos;
    if (isClear(edx, edz)) return { dirX: edx, dirZ: edz };
  }
  return null;
}

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

/**
 * Deterministic per-slot move-speed JITTER factor (T128 follow-up) so members of the SAME archetype don't move
 * in lockstep. A STABLE multiplicative hash of the slot → [-1,1), scaled by `amt` → ≈[1-amt, 1+amt]. Pure +
 * replay-stable (V26 — a function of the slot only, no RNG); `amt<=0` → exactly 1 (uniform). A recycled slot
 * inherits the same factor, which is fine (still deterministic + varied across the crowd).
 */
export function slotSpeedJitter(slot: number, amt: number): number {
  if (amt <= 0) return 1;
  const h = ((Math.imul(slot + 1, 2654435761) >>> 0) / 4294967296) * 2 - 1;
  return 1 + amt * h;
}

/**
 * Deterministic per-slot CORNER-BIAS in [0, 1) (T136) — how wide THIS zombie swings around wall corners. A
 * stable hash of the slot (a DIFFERENT multiplier than slotSpeedJitter so the two channels are decorrelated:
 * a fast zombie isn't always a wide-cornering one). Feeds steer()'s cornerBias so some of the horde rounds a
 * house corner while others cut close — the organic spread that breaks the single-file diagonal shortcut.
 * Replay-stable (V26 — slot-only, no RNG).
 */
export function slotCornerBias(slot: number): number {
  return (Math.imul(slot + 1, 0x9e3779b1) >>> 0) / 4294967296;
}

/**
 * Deterministic IDLE-WANDER heading for a target-less zombie (T137). Returns whether it ambles this interval and,
 * if so, a unit direction. The direction holds for `refreshTicks` then re-rolls; a PER-SLOT phase offset spreads
 * the re-roll across the crowd (not all turning on the same tick), and a `pauseChance` fraction of intervals the
 * body just STANDS — so a crowd that lost its target loiters + drifts organically instead of standing frozen.
 * Pure + replay-stable (a function of slot + tick only, no RNG — V26).
 */
export function idleWanderDir(
  slot: number,
  tick: number,
  refreshTicks: number,
  pauseChance: number,
): { readonly moving: boolean; readonly dirX: number; readonly dirZ: number } {
  const refresh = Math.max(1, refreshTicks);
  const phase = (Math.imul(slot + 1, 0x85ebca6b) >>> 0) % refresh; // per-slot offset so re-rolls aren't synced
  const bucket = Math.floor((tick + phase) / refresh);
  const seed = (Math.imul(slot + 1, 2654435761) ^ Math.imul(bucket + 1, 0x9e3779b1)) >>> 0;
  if (seed / 4294967296 < pauseChance) return { moving: false, dirX: 0, dirZ: 0 };
  // MEANDER, don't teleport the heading: a per-slot base direction that sweeps SMOOTHLY bucket-to-bucket
  // (a slow sinusoid), so consecutive ambles curve gently and the body ROAMS away from its spawn instead of
  // picking fully-independent directions that random-walk in place (the "lone zombie looks stuck" case). Each
  // slot gets its own base + sweep rate → the crowd still disperses in different directions. Pure (V26).
  const base = ((Math.imul(slot + 1, 0x27d4eb2f) >>> 0) / 4294967296) * (Math.PI * 2);
  const sweepRate = 0.35 + ((Math.imul(slot + 1, 0x165667b1) >>> 0) / 4294967296) * 0.5; // ~0.35..0.85 rad/bucket
  const angle = base + Math.sin(bucket * sweepRate) * (Math.PI * 0.85); // smooth ±~150° sweep
  return { moving: true, dirX: Math.cos(angle), dirZ: Math.sin(angle) };
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
  /**
   * V83/V84: the SHARED SEE-THROUGH scene (GameRuntime.sightScene) — `scene` wrapped with the see-through window
   * predicate. Zombie SIGHT routes through this so a window lets a zombie see the player UNLESS it is boarded
   * shut (2 boards) — an intact GLASS pane is transparent (you can be seen through a window), matching the
   * player's own vision + the flashlight. NOT used for sound (a wall/window muffles sound via its own occlusion
   * term) or movement collision (windows never alter nav, V68).
   */
  readonly sightScene: LosScene;
  /**
   * V100: the SOUND scene (GameRuntime.soundScene) — like `sightScene` but the window predicate is HEIGHT-
   * INDEPENDENT (an open/blasted/glassed window passes sound regardless of head height, unlike V87 sight). The
   * perception SOUND occlusion (`loudestHeardSound*`) uses this so a gunshot through a window alerts the zombies
   * outside, not only an open door.
   */
  readonly soundScene: LosScene;
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
  /** Live player nav LEVEL (P3 multi-floor). Default 0 — a single-floor scene never leaves the ground level,
   *  so the level-aware horde path is dormant and the ground hot path runs unchanged (V26 backward-compat). */
  readonly getPlayerLevel?: () => number;
  /** P3 multi-floor: the scene's level stack. Absent ⇒ derived as a single level from `scene.navGrid` (the
   *  ground hot path). Present with >1 level ⇒ the horde runs its level-aware perception + movement (climb). */
  readonly levelNav?: LevelNav;
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
  /**
   * T124/V89 — per-archetype-INDEX move-speed multipliers (registry order = the SoA `archetype` field). The
   * movement step scales the shared horde baseline (`combat.hordeMoveSpeed`) by `[archetype]` for each slot, so
   * a per-archetype speed (STANDARD 1.0 / RUNNER >1 / BLOATED <1) actually takes effect in the deterministic
   * fixed-tick sim. A flat typed array → an O(1) per-slot read, no per-tick archetype-record lookup or alloc.
   */
  readonly moveSpeedScaleByArchetype: Float32Array;
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

  // ---- P3 multi-floor (dormant unless the scene has >1 level) ----
  /** The scene's level stack (ground + sparse upper floors + stair links). One level for a single-floor scene. */
  private readonly nav: LevelNav;
  /** True only when the scene has a second storey — gates the level-aware perception + movement paths. A
   *  single-floor scene keeps `multiLevel === false`, so every step runs its ORIGINAL ground-level code. */
  private readonly multiLevel: boolean;
  /** Per-level flow fields, lazily built only on the multi-floor path. Targets are stored as GLOBAL cells. */
  private readonly levelFlowCache: LevelFlowFieldCache | null;
  /** Active per-tick fields by GLOBAL target cell (multi-floor analogue of activeFieldByCell). */
  private readonly activeLevelFieldByGlobal = new Map<number, LevelFlowField>();

  constructor(private readonly d: HordeSimulationDeps) {
    this.consequence = {
      armLossLocomotionPenalty: d.combatCfg.armLossLocomotionPenalty,
      legLossLocomotionPenalty: d.combatCfg.legLossLocomotionPenalty,
      armLossThreatPenalty: d.combatCfg.armLossThreatPenalty,
      legsLostToCrawl: d.combatCfg.legsLostToCrawl,
    };
    this.targetExpiry = new Int32Array(d.zombies.capacity).fill(-1);
    this.nav = d.levelNav ?? levelNavOf(d.scene);
    this.multiLevel = this.nav.levelCount > 1;
    this.levelFlowCache = this.multiLevel
      ? new LevelFlowFieldCache(d.scene.navGrid.settings.flowFieldCacheSize)
      : null;
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
    if (this.multiLevel) {
      this.stepMovementMulti();
      return;
    }
    const { zombies, spatial, scene, combatCfg, clock, agentRadius } = this.d;
    const dt = clock.tickSeconds;
    const speed = combatCfg.hordeMoveSpeed;
    const scaleByArch = this.d.moveSpeedScaleByArchetype; // T124/V89: per-archetype speed multiplier (per slot)
    const jitterAmt = combatCfg.hordeMoveSpeedJitter; // per-slot ± spread so the crowd isn't homogeneous
    const sep = combatCfg.steerSeparationMeters;
    const flowWeight = combatCfg.steerFlowWeight;
    const wallWeight = combatCfg.steerWallClearanceWeight; // T134/V101: bias the heading off nearby walls
    const wallProbe = combatCfg.steerWallClearanceProbeMeters;
    const maxTurn = combatCfg.hordeMaxTurnRateRadPerSec * dt; // T141: max facing rotation per tick (anti-180°-flip)
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
      zombies.getPosition(slot, pos);
      if (!field) {
        // No target → IDLE WANDER (T137): amble in a slow per-slot direction instead of standing frozen.
        this.stepIdleWander(slot, pos, clock.tick);
        return;
      }
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
      // T124/V89: scale the shared baseline by THIS body's archetype factor (STANDARD 1.0 / RUNNER >1 / BLOATED <1).
      const effSpeed = speed * scaleByArch[zombies.getArchetype(slot)]! * moveScale * slotSpeedJitter(slot, jitterAmt);
      const ids = spatial.query(pos[0], pos[2], sep, MOVEMENT_MASK, { exclude: slot });
      const neighbors = ids.map((id) => {
        const a = spatial.get(id);
        return { dx: a.x - pos[0], dz: a.z - pos[2] };
      });
      const { dirX, dirZ, flowX, flowZ } = steer(field, {
        x: pos[0],
        z: pos[2],
        neighbors,
        separation: sep,
        flowWeight,
        wallClearanceProbe: wallProbe, // T134/V101: smooth interpolated heading + wall-clearance bias
        wallClearanceWeight: wallWeight,
        cornerBias: slotCornerBias(slot), // T136: per-zombie wide-vs-tight corner berth (organic, near walls only)
      });
      if (dirX === 0 && dirZ === 0) {
        zombies.setVelocity(slot, 0, 0, 0);
        return;
      }
      const step = effSpeed * dt;
      const nx = pos[0] + dirX * step;
      const nz = pos[2] + dirZ * step;
      // T58/V42: radius-aware static collision + wall-slide so a body never clips half into a wall. The
      // edge-wall test additionally rejects a step that would cross an interior partition between two walkable
      // cells (the flow field already routes the body to the doorway; this stops the final-step clip-through).
      const grid = scene.navGrid;
      let mx = pos[0];
      let mz = pos[2];
      let headX = dirX;
      let headZ = dirZ;
      let moved = false;
      if (isWalkableRadius(scene, nx, nz, agentRadius) && !segmentCrossesWall(grid, pos[0], pos[2], nx, nz)) {
        mx = nx;
        mz = nz;
        moved = true;
      } else if (isWalkableRadius(scene, nx, pos[2], agentRadius) && !segmentCrossesWall(grid, pos[0], pos[2], nx, pos[2])) {
        mx = nx;
        moved = true;
      } else if (isWalkableRadius(scene, pos[0], nz, agentRadius) && !segmentCrossesWall(grid, pos[0], pos[2], pos[0], nz)) {
        mz = nz;
        moved = true;
      } else {
        // Desired flow step + BOTH axis-slides blocked. WHY it is blocked decides what to do (T136 anti-wiggle):
        //  - The body's own cell is REACHABLE in the field → it just needs to wall-FOLLOW around a corner toward
        //    a target it CAN reach: rotate the heading through the deterministic escape fan (T134/V101) and take
        //    the first clear step.
        //  - The body's cell is UNREACHABLE in the field → its target sits behind glass / a sealed wall (the
        //    flow fell back to a straight beeline). There is NO way around, so escape-fanning just sidesteps
        //    back and forth every tick — the "glitch around and wiggle like crazy when they can't get in" bug.
        //    Instead HOLD and face the target so the body PRESSES the obstacle (the window attrition breaks in).
        const cs = grid.settings.navCellSize;
        const bcx = Math.floor(pos[0] / cs);
        const bcy = Math.floor(pos[2] / cs);
        const bodyReachable =
          bcx >= 0 && bcy >= 0 && bcx < grid.width && bcy < grid.height && field.isReachable(bcy * grid.width + bcx);
        if (bodyReachable) {
          for (let i = 0; i < STUCK_ESCAPE_FAN.length; i++) {
            const r = STUCK_ESCAPE_FAN[i]!;
            const edx = dirX * r.cos - dirZ * r.sin;
            const edz = dirX * r.sin + dirZ * r.cos;
            const ex = pos[0] + edx * step;
            const ez = pos[2] + edz * step;
            if (isWalkableRadius(scene, ex, ez, agentRadius) && !segmentCrossesWall(grid, pos[0], pos[2], ex, ez)) {
              mx = ex;
              mz = ez;
              headX = edx;
              headZ = edz;
              moved = true;
              break;
            }
          }
        }
      }
      // FACE the goal, not the move dir: the body looks toward its target (flow, or a beeline to a sealed target)
      // — DECOUPLED from the separation-blended/escape move dir — turn-rate-clamped so a jostled, blocked body
      // smoothly keeps looking where it wants (window/wall) instead of flip-flopping 180° with the repulsion.
      const faceAngle = flowX !== 0 || flowZ !== 0 ? Math.atan2(flowZ, flowX) : Math.atan2(dirZ, dirX);
      zombies.setHeading(slot, turnToward(zombies.getHeading(slot), faceAngle, maxTurn));
      if (moved) {
        zombies.setPosition(slot, mx, pos[1], mz);
        zombies.setVelocity(slot, headX * effSpeed, 0, headZ * effSpeed);
        spatial.update(slot, mx, mz);
      } else {
        // Held in place (blocked) — pressing the obstacle toward the target; facing already set above.
        zombies.setVelocity(slot, 0, 0, 0);
      }
    });

    // B4 / V19: the steering above only SOFT-separates. Resolve any remaining hard interpenetration
    // among the individually-visible tiers so bodies never visibly overlap. Abstract/low stays exempt.
    this.resolveCrowdOverlap();
  }

  /**
   * T137 idle wander: a target-less zombie ambles in a slow, deterministic per-slot direction (idleWanderDir)
   * instead of standing frozen, so a crowd that lost its target disperses + drifts naturally. Collision-gated
   * exactly like the pursuit step (radius-walkable + no walled-edge cross), so a wanderer never clips a wall;
   * a blocked amble just holds + faces the direction (the next interval re-rolls it). No flow field is used —
   * wander is a direct heading, so it never consumes the capped flow-field budget (V15).
   */
  private stepIdleWander(slot: ZombieSlot, pos: readonly [number, number, number], tick: number): void {
    const { zombies, scene, spatial, combatCfg, clock, agentRadius } = this.d;
    const w = idleWanderDir(slot, tick, combatCfg.hordeWanderRefreshTicks, combatCfg.hordeWanderPauseChance);
    if (!w.moving) {
      zombies.setVelocity(slot, 0, 0, 0); // loitering this interval — stand
      return;
    }
    const speed = combatCfg.hordeMoveSpeed * combatCfg.hordeWanderSpeedFraction;
    const step = speed * clock.tickSeconds;
    const grid = scene.navGrid;
    // Try the chosen amble heading, then ever-wider offsets, taking the first CLEAR step — so a wanderer that
    // ambles toward a wall/furniture re-aims and keeps moving instead of standing pinned for the whole interval.
    for (const r of WANDER_FAN) {
      const dx = w.dirX * r.cos - w.dirZ * r.sin;
      const dz = w.dirX * r.sin + w.dirZ * r.cos;
      const nx = pos[0] + dx * step;
      const nz = pos[2] + dz * step;
      if (isWalkableRadius(scene, nx, nz, agentRadius) && !segmentCrossesWall(grid, pos[0], pos[2], nx, nz)) {
        zombies.setPosition(slot, nx, pos[1], nz);
        zombies.setHeading(slot, Math.atan2(dz, dx));
        zombies.setVelocity(slot, dx * speed, 0, dz * speed);
        spatial.update(slot, nx, nz);
        return;
      }
    }
    // Genuinely boxed in on all sides this tick — hold + keep facing the desired heading.
    zombies.setHeading(slot, Math.atan2(w.dirZ, w.dirX));
    zombies.setVelocity(slot, 0, 0, 0);
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
   * P3 multi-floor movement: the level-aware analogue of `stepMovement`, run ONLY when the scene has >1 level.
   * Each zombie follows the per-LEVEL flow field for its GLOBAL target cell; a body whose cheapest next step is
   * a stair link CLIMBS (transitions level + snaps to the linked cell), else it steers in-plane on its own
   * level's grid (per-level walkable + edge-wall tests). Same steering/separation math as the ground path; only
   * the grid + the climb branch differ. Mirrors `stepMovement`'s stagger/anatomy/arrival handling.
   */
  private stepMovementMulti(): void {
    const { zombies, spatial, scene, combatCfg, clock, agentRadius } = this.d;
    const nav = this.nav;
    const dt = clock.tickSeconds;
    const speed = combatCfg.hordeMoveSpeed;
    const scaleByArch = this.d.moveSpeedScaleByArchetype; // T124/V89: per-archetype speed multiplier (per slot)
    const jitterAmt = combatCfg.hordeMoveSpeedJitter; // per-slot ± spread so the crowd isn't homogeneous
    const sep = combatCfg.steerSeparationMeters;
    const flowWeight = combatCfg.steerFlowWeight;
    const wallWeight = combatCfg.steerWallClearanceWeight; // T134/V101: mirror the wall-clearance + escape fix
    const wallProbe = combatCfg.steerWallClearanceProbeMeters;
    const maxTurn = combatCfg.hordeMaxTurnRateRadPerSec * dt; // T141: max facing rotation per tick (anti-180°-flip)
    const pos: [number, number, number] = [0, 0, 0];
    const arriveR2 = combatCfg.hordeArriveRadiusMeters * combatCfg.hordeArriveRadiusMeters;

    this.buildActiveLevelFields();
    const fieldByGlobal = this.activeLevelFieldByGlobal;

    zombies.forEachAlive((slot) => {
      if (zombies.getNavGroup(slot) < 0) return;

      if (zombies.getState(slot) === ZombieState.Stagger) {
        const remaining = zombies.getStateTimer(slot) - dt;
        if (remaining > 0) zombies.setStateTimer(slot, remaining);
        else {
          zombies.setStateTimer(slot, 0);
          zombies.setState(slot, ZombieState.Idle);
        }
        zombies.setVelocity(slot, 0, 0, 0);
        return;
      }

      const targetGlobal = zombies.getTarget(slot);
      const field = targetGlobal >= 0 ? fieldByGlobal.get(targetGlobal) : undefined;
      if (!field) {
        zombies.setVelocity(slot, 0, 0, 0);
        return;
      }
      zombies.getPosition(slot, pos);
      const level = zombies.getLevel(slot);
      const move = resolveLevelMove(field, nav, level, pos[0], pos[2]);

      if (move.kind === 'idle') {
        zombies.setVelocity(slot, 0, 0, 0);
        return;
      }
      if (move.kind === 'climb') {
        // Take the stair portal: transition level + snap to the linked cell's world centre (XZ stacked). The
        // body keeps its sim y (render offsets by level); the spatial hash is re-bucketed at the new XZ.
        const toGrid = nav.grid(move.toLevel);
        const c = toGrid.coordOf(move.toCell);
        const center = scene.cellCenter({ cx: c.cx, cy: c.cy });
        zombies.setLevel(slot, move.toLevel);
        zombies.setPosition(slot, center.x, pos[1], center.z);
        zombies.setVelocity(slot, 0, 0, 0);
        spatial.update(slot, center.x, center.z);
        return;
      }

      // steer in-plane on this level's grid.
      const { decoded } = this.decodeTargetCenter(targetGlobal);
      if (decoded.level === level) {
        const adx = decoded.centerX - pos[0];
        const adz = decoded.centerZ - pos[2];
        if (adx * adx + adz * adz <= arriveR2) {
          zombies.setVelocity(slot, 0, 0, 0);
          return;
        }
      }
      let moveScale = 1;
      const flags = zombies.getAnatomyFlags(slot);
      if (flags !== 0) {
        const cons = limbConsequences(flags, this.consequence);
        moveScale = cons.locomotionScale;
        zombies.setAnimState(slot, cons.posture);
        if (moveScale <= 0) {
          zombies.setVelocity(slot, 0, 0, 0);
          return;
        }
      }
      // T124/V89: scale the shared baseline by THIS body's archetype factor (STANDARD 1.0 / RUNNER >1 / BLOATED <1).
      const effSpeed = speed * scaleByArch[zombies.getArchetype(slot)]! * moveScale * slotSpeedJitter(slot, jitterAmt);
      const ids = spatial.query(pos[0], pos[2], sep, MOVEMENT_MASK, { exclude: slot });
      const neighbors = ids.map((id) => {
        const a = spatial.get(id);
        return { dx: a.x - pos[0], dz: a.z - pos[2] };
      });
      const grid = nav.grid(level);
      // T134/V101: wall-clearance bias on THIS level's grid (resolveLevelMove already supplies the flow vector;
      // the bilinear interpolation is single-floor-only — it routes through `steer`, which this path bypasses).
      const wb = wallWeight > 0 && wallProbe > 0 ? wallClearanceBias(grid, pos[0], pos[2], wallProbe) : null;
      const { dirX, dirZ, flowX, flowZ } = combineSteer(
        move.flowX,
        move.flowZ,
        { x: pos[0], z: pos[2], neighbors, separation: sep, flowWeight },
        wb?.x ?? 0,
        wb?.z ?? 0,
        wb ? cornerBiasedWallWeight(wallWeight, slotCornerBias(slot)) : 0, // T136: per-zombie wide-vs-tight berth
      );
      if (dirX === 0 && dirZ === 0) {
        zombies.setVelocity(slot, 0, 0, 0);
        return;
      }
      const step = effSpeed * dt;
      const nx = pos[0] + dirX * step;
      const nz = pos[2] + dirZ * step;
      let mx = pos[0];
      let mz = pos[2];
      let headX = dirX;
      let headZ = dirZ;
      let moved = false;
      if (gridWalkableRadius(grid, nx, nz, agentRadius) && !segmentCrossesWall(grid, pos[0], pos[2], nx, nz)) {
        mx = nx;
        mz = nz;
        moved = true;
      } else if (gridWalkableRadius(grid, nx, pos[2], agentRadius) && !segmentCrossesWall(grid, pos[0], pos[2], nx, pos[2])) {
        mx = nx;
        moved = true;
      } else if (gridWalkableRadius(grid, pos[0], nz, agentRadius) && !segmentCrossesWall(grid, pos[0], pos[2], pos[0], nz)) {
        mz = nz;
        moved = true;
      } else {
        // T134/V101: STUCK on this level → the same deterministic escape fan wall-follows around the corner.
        for (let i = 0; i < STUCK_ESCAPE_FAN.length; i++) {
          const r = STUCK_ESCAPE_FAN[i]!;
          const edx = dirX * r.cos - dirZ * r.sin;
          const edz = dirX * r.sin + dirZ * r.cos;
          const ex = pos[0] + edx * step;
          const ez = pos[2] + edz * step;
          if (gridWalkableRadius(grid, ex, ez, agentRadius) && !segmentCrossesWall(grid, pos[0], pos[2], ex, ez)) {
            mx = ex;
            mz = ez;
            headX = edx;
            headZ = edz;
            moved = true;
            break;
          }
        }
      }
      // FACE the goal (flow / beeline), decoupled from the separation-blended move dir + turn-rate-clamped — the
      // body keeps looking at its target while blocked/jostled instead of flip-flopping (mirrors the single-floor path).
      const faceAngle = flowX !== 0 || flowZ !== 0 ? Math.atan2(flowZ, flowX) : Math.atan2(dirZ, dirX);
      zombies.setHeading(slot, turnToward(zombies.getHeading(slot), faceAngle, maxTurn));
      if (moved) {
        zombies.setPosition(slot, mx, pos[1], mz);
        zombies.setVelocity(slot, headX * effSpeed, 0, headZ * effSpeed);
        spatial.update(slot, mx, mz);
      } else {
        zombies.setVelocity(slot, 0, 0, 0);
      }
    });

    // Soft separation across the visible tiers (XZ only — cross-level overlap is rare on the sparse upstairs).
    this.resolveCrowdOverlap();
  }

  /** Decode a GLOBAL target cell to its level + world-centre XZ (cached per call site; cheap). */
  private decodeTargetCenter(global: number): { decoded: { level: number; centerX: number; centerZ: number } } {
    const { level, cell } = this.nav.decode(global);
    const grid = this.nav.grid(level);
    const c = grid.coordOf(cell);
    const center = this.d.scene.cellCenter({ cx: c.cx, cy: c.cy });
    return { decoded: { level, centerX: center.x, centerZ: center.z } };
  }

  /**
   * Multi-floor analogue of `buildActiveFields`: group the horde by GLOBAL target cell, assign the capped flow
   * budget to the most-pursued cells, and build a per-LEVEL field for each. Deterministic ordering (V12/V26).
   */
  private buildActiveLevelFields(): void {
    const { zombies, perception } = this.d;
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
      } else counts.set(tc, prev + 1);
    });

    this.activeLevelFieldByGlobal.clear();
    if (distinct.length === 0) return;
    distinct.sort(this.compareByPopularity);
    const limit = Math.min(perception.maxSimultaneousFlowFields, distinct.length);
    const cache = this.levelFlowCache!;
    for (let i = 0; i < limit; i++) {
      const global = distinct[i]!;
      const { level, cell } = this.nav.decode(global);
      if (this.nav.grid(level).isBlocked(cell)) continue;
      this.activeLevelFieldByGlobal.set(global, cache.get(this.nav, level, cell, MOVEMENT_PROFILE));
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

    // A depenetration push is committed only if the body can actually SLIDE there: radius-aware walkable AND it
    // does not cross a walled cell EDGE (the thin-wall house model leaves both flanking cells walkable, so a
    // destination-only test let crowd pressure shove a body straight through a wall into a house, V42/V101).
    const grid = this.d.scene.navGrid;
    const moved = resolveSeparation(
      pool,
      neighborsOf,
      (fx, fz, tx, tz, r) => isWalkableRadius(this.d.scene, tx, tz, r) && !segmentCrossesWall(grid, fx, fz, tx, tz),
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
    if (this.multiLevel) {
      this.stepPerceptionMulti(ctx);
      return;
    }
    const { zombies, perception, playerEntityId, getPlayerPos, scene, sightScene, stimulus } = this.d;
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
      // V47: walls / closed doors block sight — no seeing the player through solid structure. V83/V84: routed
      // through the SEE-THROUGH sightScene so a window lets the zombie see the player THROUGH its glass (an intact
      // pane is transparent) UNLESS it is boarded shut (2 boards), matching the player's own vision + flashlight.
      if (inSight) inSight = hasLineOfSight(sightScene, pos[0], pos[2], p.x, p.z);
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

  /** Live player level (P3) — 0 unless the runtime wires `getPlayerLevel` and the player has climbed. */
  private playerLevelNow(): number {
    return this.d.getPlayerLevel?.() ?? 0;
  }

  /**
   * P3 multi-floor perception: the level-aware analogue of `stepPerception`, run ONLY when the scene has >1
   * level. Targets are GLOBAL cells (level + cell). A zombie that SENSES the player targets the player's CURRENT
   * (level, cell) — so once acquired it pursues across floors and the field climbs it up the stairs; a heard
   * sound targets that sound's cell on the HEARER's own level (cross-floor sound bleed is P3c). All levels share
   * the district cell dimensions, so a cell index means the same XZ on every level (stair links connect equal
   * indices). NOTE (P3b): cross-level LOS is approximated by the ground-projection LOS; P3c tightens it to a
   * per-level + stairwell-gated test.
   */
  private stepPerceptionMulti(ctx: SystemContext): void {
    const { zombies, perception, playerEntityId, getPlayerPos, stimulus } = this.d;
    stimulus.update(ctx.tick);
    const p = getPlayerPos();
    const nav = this.nav;
    const playerLevel = this.playerLevelNow();
    const sight = perception.sightRange;
    const fovHalf = (perception.fieldOfViewDegrees * Math.PI) / 360;
    const coned = fovHalf < Math.PI;
    const attackRange = perception.attackRangeMeters;
    const investigate = perception.investigateTicks;
    const pGrid = nav.grid(playerLevel);
    const pc = pGrid.worldToCell(p.x, p.z);
    const playerGlobal =
      pc.cx >= 0 && pc.cy >= 0 && pc.cx < pGrid.width && pc.cy < pGrid.height
        ? nav.globalCell(playerLevel, pGrid.index(pc.cx, pc.cy))
        : -1;
    const pos: [number, number, number] = [0, 0, 0];
    zombies.forEachAlive((slot) => {
      zombies.getPosition(slot, pos);
      const zlevel = zombies.getLevel(slot);
      const dx = p.x - pos[0];
      const dz = p.z - pos[2];
      const dist = Math.hypot(dx, dz);
      // P3c: sight is CONTAINED within a level — a zombie sees the player only on its OWN floor, through that
      // floor's walls (no seeing through a ceiling). Cross-floor awareness comes from sound bleed (below).
      let inSight = zlevel === playerLevel && dist <= sight;
      if (inSight && coned) inSight = withinCone(dx, dz, zombies.getHeading(slot), fovHalf);
      if (inSight) inSight = gridHasLineOfSight(nav.grid(zlevel), pos[0], pos[2], p.x, p.z);
      const sensesPlayer = inSight && playerGlobal >= 0;

      let target: number;
      let acquired = false;
      if (sensesPlayer) {
        target = playerGlobal;
        acquired = true;
      } else {
        // P3c: a heard sound is targeted on the SOUND's own level (cross-floor sounds bleed up/down the
        // stairwell, attenuated) — so a gunshot downstairs pulls an upstairs body toward the stairs + down.
        const heardGlobal = this.loudestHeardSoundGlobal(pos[0], pos[2], zlevel, ctx.tick);
        if (heardGlobal >= 0) {
          target = heardGlobal;
          acquired = true;
        } else if (zombies.getTarget(slot) >= 0 && ctx.tick <= this.targetExpiry[slot]!) {
          target = zombies.getTarget(slot);
        } else {
          target = -1;
        }
      }
      zombies.setTarget(slot, target);
      if (acquired) this.targetExpiry[slot] = ctx.tick + investigate;
      zombies.setStimulus(slot, sensesPlayer ? playerEntityId : -1);

      if (zombies.getState(slot) === ZombieState.Stagger && zombies.getStateTimer(slot) > 0) return;
      let state: number;
      // Attack only when on the player's level AND in reach; otherwise pursue (climb) / wander / idle.
      if (sensesPlayer) state = zlevel === playerLevel && dist <= attackRange ? ZombieState.Attack : ZombieState.Pursue;
      else if (target >= 0) state = ZombieState.Wander;
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
    const { stimulus, scene, soundScene, perception } = this.d;
    const navGrid = scene.navGrid;
    const threshold = perception.alertIntensityThreshold;
    const hits = stimulus.query(x, z, tick);
    let bestCell = -1;
    let bestIntensity = -1;
    for (const h of hits) {
      if (h.stimulus.kind !== 'sound') continue;
      // V98/V100: SOUND occlusion is WINDOW-AWARE on the HEIGHT-INDEPENDENT `soundScene` — an open / blasted /
      // glassed window (or doorway) lets the shot through UNMUFFLED regardless of head height (sight's V87 band
      // does NOT apply to sound), so firing out a window alerts the zombies outside, not only an open door. A
      // solid wall / boarded-shut window still muffles (×soundWallOcclusion).
      const occluded = !hasLineOfSight(soundScene, h.stimulus.x, h.stimulus.z, x, z);
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
   * P3c multi-floor analogue of `loudestHeardSoundCell`: the GLOBAL cell of the loudest sound reaching (x,z) for
   * a hearer on `hearerLevel`. A sound made on a DIFFERENT level is attenuated by the sound-through-floor factor
   * raised to the floor distance (V4) — it bleeds up/down the stairwell, muffled — and its target is the sound's
   * cell ON ITS OWN LEVEL, so the hearer paths toward the stairs + climbs/descends to investigate. Same-floor
   * sounds keep the in-plane wall occlusion (V28). All levels share the cell dims, so the XZ cell index is common.
   */
  private loudestHeardSoundGlobal(x: number, z: number, hearerLevel: number, tick: number): number {
    const { stimulus, soundScene, perception } = this.d;
    const nav = this.nav;
    const threshold = perception.alertIntensityThreshold;
    const floorAtt = perception.soundThroughFloorAttenuation;
    const hits = stimulus.query(x, z, tick);
    let bestGlobal = -1;
    let bestIntensity = -1;
    for (const h of hits) {
      if (h.stimulus.kind !== 'sound') continue;
      const soundLevel = h.stimulus.level ?? 0;
      const floors = Math.abs(soundLevel - hearerLevel);
      // in-plane occlusion (same floor) OR per-floor muffle (cross floor). The straight XZ ray approximates the
      // path; for a cross-floor sound the floor factor models the stairwell bleed.
      let intensity = h.intensity;
      if (floors === 0) {
        // V98/V100: window-aware on the height-independent soundScene (open/blasted/glassed window passes sound).
        if (!hasLineOfSight(soundScene, h.stimulus.x, h.stimulus.z, x, z)) intensity *= perception.soundWallOcclusion;
      } else {
        intensity *= Math.pow(floorAtt, floors);
      }
      if (intensity < threshold) continue;
      const grid = nav.grid(soundLevel);
      const c = grid.worldToCell(h.stimulus.x, h.stimulus.z);
      if (c.cx < 0 || c.cy < 0 || c.cx >= grid.width || c.cy >= grid.height) continue;
      const local = grid.index(c.cx, c.cy);
      if (grid.isBlocked(local)) continue; // no field can be built to a blocked cell (e.g. a sound off the upstairs footprint)
      const global = nav.globalCell(soundLevel, local);
      if (intensity > bestIntensity || (intensity === bestIntensity && global < bestGlobal)) {
        bestIntensity = intensity;
        bestGlobal = global;
      }
    }
    return bestGlobal;
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
    const plevel = this.playerLevelNow();
    zombies.forEachAlive((slot) => {
      if (zombies.getState(slot) !== ZombieState.Attack) return; // staggered/pursuing/idle do not bite
      if (this.multiLevel && zombies.getLevel(slot) !== plevel) return; // P3: never bite across a floor
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
