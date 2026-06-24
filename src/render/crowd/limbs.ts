// T72 / V2 / V3 / V13 / V17 — block-limbed render path (pure CPU core).
// Hero (simTier 0) + active-crowd (simTier 1) zombies must read as FIGURES so dismemberment is VISIBLE,
// so each is composed from a small fixed set of body-part boxes (head/torso/armL/armR/legL/legR). This
// module owns the PURE, GPU-free core: it (a) compacts the limbed-tier slots out of the SoA into per-
// instance input arrays (capped to the limbed budget — a render POOL cap, no throw), and (b) composes the
// per-(instance,part) transform mat4 from the zombie pose + a STATE-DRIVEN swing/bob/reach. The Crowd class
// wires these floats into one InstancedMesh PER PART (NO per-zombie object/mesh, V2). Reads SoA only (V3);
// never writes back to the sim. Kept three-free so it unit-tests without a GPU device.
//
// T111 / V75 — the animation reflects what the zombie is DOING: the per-slot ZombieState + per-zombie speed
// pick the swing AMPLITUDE + stride FREQUENCY + the attack REACH via pure `limbGait`/`gaitPhaseRateHz`. idle
// ≈ a near-still breathing weight-shift; walk = moderate arm/leg counter-swing paced to speed; chase = a
// faster/wider/deeper running gait; attack = a forward arm LUNGE (both arms reach toward the heading, NOT the
// locomotion counter-swing). Per-slot phase is advanced render-side at the per-state frequency (the SoA
// animPhase is sim-owned + unadvanced), seeded with per-slot offsets so figures never march in lockstep.

import type { FieldViews } from '../../game/core/contracts/soa';
import { ZombieState } from '../../game/simulation';
import { variationScale, variationSeed } from './packing';
import { visionCullFade, type VisionCull } from './visionCull';

const TAU = Math.PI * 2;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Floats of per-instance pose input: [posX, posY, posZ, headingRadians]. */
export const FLOATS_PER_LIMB_POSE = 4;
/** Elements written per composed instance transform (one column-major mat4). */
export const FLOATS_PER_MAT4 = 16;

function requireView<T>(views: FieldViews, name: string): T {
  const v = views[name];
  if (!v) throw new Error(`SoA view '${name}' missing — limbed crowd requires the frozen ZOMBIE_FIELDS layout`);
  return v as unknown as T;
}

/**
 * Per-state gait tunables (T111/V75) resolved from the rendering config; passed to the pure gait functions so
 * they stay GPU-free + unit-testable. Walk swing/bob reuse the existing crowdLimbWalkSwingRadians/
 * crowdLimbBobMeters; idle/chase/attack carry their own. `speedRef` is the speed (m/s) at which a walking/
 * chasing figure reaches full amplitude + stride rate.
 */
export interface LimbGaitConfig {
  readonly idleSwingRadians: number;
  readonly walkSwingRadians: number;
  readonly chaseSwingRadians: number;
  readonly idleFreqHz: number;
  readonly walkFreqHz: number;
  readonly chaseFreqHz: number;
  readonly idleBobMeters: number;
  readonly walkBobMeters: number;
  readonly chaseBobMeters: number;
  readonly attackReachRadians: number;
  /** Steady forward arm-reach while CHASING (Pursue) — the classic zombie arms-out lurch (T122/V87). */
  readonly chaseReachRadians: number;
  readonly attackFreqHz: number;
  /** Ease rate (Hz) the per-slot arm-raise converges to its per-state target so it never hard-snaps (T122/V87). */
  readonly reachBlendHz: number;
  readonly speedRefMetersPerSecond: number;
}

/**
 * One figure's per-frame gait output. Magnitudes ONLY — composeLimbMatrix applies the per-part swingSign /
 * reachSign so legs+arms counter-swing for locomotion while the attack reach drives BOTH arms forward.
 *  - `swing` final locomotion swing value about local X (already phase-curved), × swingSign per part.
 *  - `bob`   final vertical body bob (meters), added to every part.
 *  - `reach` forward arm-reach value (already phase-curved), × reachSign per part; >0 only during attack
 *            (a forward lunge); <0 during stagger (a backward recoil); 0 otherwise.
 */
export interface LimbGait {
  swing: number;
  bob: number;
  reach: number;
}

/** Body bob curve: double-frequency |sin| (two steps per stride) reads as a gait without limb IK. */
function bobCurve(phase: number): number {
  return Math.abs(Math.sin(phase * TAU));
}

/**
 * Behaviour-state → animation-phase rate (Hz) — how fast a figure's gait cycle advances (T111/V75). Walk +
 * chase scale from the idle floor up to their full rate by the locomotion factor (clamp(speed/speedRef,0,1))
 * so a barely-moving body shuffles and a sprinter strides; attack runs the lunge pulse; idle/down/unknown
 * tick at the slow breathing rate. PURE: output depends only on the inputs (deterministic).
 */
export function gaitPhaseRateHz(state: number, speed: number, cfg: LimbGaitConfig): number {
  const factor = clamp01(speed / cfg.speedRefMetersPerSecond);
  switch (state) {
    case ZombieState.Pursue:
      return lerp(cfg.idleFreqHz, cfg.chaseFreqHz, factor);
    case ZombieState.Wander:
      return lerp(cfg.idleFreqHz, cfg.walkFreqHz, factor);
    case ZombieState.Attack:
      return cfg.attackFreqHz;
    case ZombieState.Stagger:
      return cfg.chaseFreqHz; // a fast jitter for the recoil
    case ZombieState.Idle:
    case ZombieState.Down:
    default:
      return cfg.idleFreqHz;
  }
}

/**
 * Behaviour-state → FORWARD arm-reach TARGET (radians, phase-pulsed) — the value the eased per-slot arm-raise
 * chases (T122/V87). It is the single source of the reach so the easing in `packLimbInputs` and the instantaneous
 * value in `limbGait` agree. Sign is a MAGNITUDE; `composeLimbMatrix` applies each arm's `reachSign` so BOTH arms
 * reach the same way (forward), not the locomotion counter-swing.
 *  - Pursue (chase): a STEADY forward reach (the classic zombie arms-out lurch) with a gentle pulse.
 *  - Attack: a stronger grasping LUNGE pulse.
 *  - Stagger: a brief BACKWARD recoil (negative).
 *  - Idle / Wander / Down: 0 — the arms hang and lumber.
 * PURE: depends only on the inputs (deterministic, V26).
 */
export function stateReachTarget(state: number, phase: number, cfg: LimbGaitConfig): number {
  const s = Math.sin(phase * TAU);
  switch (state) {
    case ZombieState.Pursue:
      return cfg.chaseReachRadians * (0.75 + 0.25 * s);
    case ZombieState.Attack:
      return cfg.attackReachRadians * (0.6 + 0.4 * s);
    case ZombieState.Stagger:
      return -cfg.attackReachRadians * 0.5 * Math.abs(s);
    case ZombieState.Idle:
    case ZombieState.Wander:
    case ZombieState.Down:
    default:
      return 0;
  }
}

/**
 * Behaviour-state → per-figure swing/bob/reach for the current phase (T111/V75). Writes into the caller-owned
 * `out` (reused per frame → allocation-free, V24) and returns it. PURE: output depends only on the inputs
 * (state/speed/phase/cfg), so it is deterministic + unit-testable without a GPU.
 *  - idle/down: a near-still breathing weight-shift (idle swing + idle bob), no reach.
 *  - walk: counter-swing + bob, amplitude scaled by the locomotion factor (paced to speed).
 *  - chase (Pursue): wider swing + deeper bob (running) PLUS a steady FORWARD arm reach (the lurch, T122/V87).
 *  - attack: legs near-planted (idle swing); a stronger FORWARD arm reach (always forward, pulsing) — the lunge.
 *  - stagger: a jerky swing + a brief BACKWARD arm recoil (negative reach).
 */
export function limbGait(out: LimbGait, state: number, speed: number, phase: number, cfg: LimbGaitConfig): LimbGait {
  const s = Math.sin(phase * TAU);
  const factor = clamp01(speed / cfg.speedRefMetersPerSecond);
  switch (state) {
    case ZombieState.Pursue:
      // Running gait + a steady forward arm reach (the chase lurch — reach via stateReachTarget below, T122/V87).
      out.swing = cfg.chaseSwingRadians * factor * s;
      out.bob = bobCurve(phase) * lerp(cfg.idleBobMeters, cfg.chaseBobMeters, factor);
      break;
    case ZombieState.Wander:
      out.swing = cfg.walkSwingRadians * factor * s;
      out.bob = bobCurve(phase) * lerp(cfg.idleBobMeters, cfg.walkBobMeters, factor);
      break;
    case ZombieState.Attack:
      // Planted legs (minimal swing) + a forward grasping lunge (reach via stateReachTarget below).
      out.swing = cfg.idleSwingRadians * s;
      out.bob = bobCurve(phase) * cfg.idleBobMeters;
      break;
    case ZombieState.Stagger:
      // Brief recoil: a jerky swing + arms thrown BACK (negative reach → backward via reachSign).
      out.swing = cfg.chaseSwingRadians * s;
      out.bob = bobCurve(phase) * cfg.idleBobMeters;
      break;
    case ZombieState.Idle:
    case ZombieState.Down:
    default:
      // Near-still: a subtle breathing weight-shift, minimal limb swing, no reach.
      out.swing = cfg.idleSwingRadians * s;
      out.bob = bobCurve(phase) * cfg.idleBobMeters;
      break;
  }
  // Reach (forward arm-raise) is the single state→reach mapping shared with packLimbInputs' eased accumulator.
  out.reach = stateReachTarget(state, phase, cfg);
  return out;
}

export interface LimbPackOptions {
  /** Number of SoA slots to scan (<= SoA capacity). */
  readonly count: number;
  /** Limbed-instance budget — out arrays hold this many; overflow is capped (render pool, V13). */
  readonly capacity: number;
  readonly variationCount: number;
  readonly scaleMin: number;
  readonly scaleMax: number;
  /** Slots with simTier <= this are promoted to the limbed (figure) path (V13). */
  readonly maxSimTier: number;
  /**
   * Distance-ranked figure membership (packing.computeFigureMask): 1 = this slot is a near figure → drawn here;
   * else the box path draws it. When provided it REPLACES the slot-order rank so the figures are the NEAREST
   * `budget` zombies, not the first in SoA order (the "boxes on the nearest zombies" fix). Same mask the box +
   * rigged passes consult, so the partition is identical across all three.
   */
  readonly figureMask?: Uint8Array | undefined;
  /**
   * Optional vision-cone fog-of-war cull (T96): hide figures outside the player's forward cone / range /
   * line-of-sight and fade those near the edges. A culled figure keeps its budget RANK (so the box path does
   * not redraw it) but writes no instance. Undefined = no cull.
   */
  readonly visibility?: VisionCull | undefined;
  /** Per-figure reveal ALPHA output (V65): the fade is written here, NOT baked into scale, so figures fade
   *  in/out instead of shrinking. Compacted to the front like the other outputs. */
  readonly outFade?: Float32Array | undefined;
  /**
   * Per-figure EASED forward arm-reach output (radians, T122/V87): the per-slot `reachState` accumulator is eased
   * toward `stateReachTarget` at `gait.reachBlendHz` and the result written here (compacted), so a zombie that just
   * noticed the player RAISES its arms smoothly instead of snapping. composeLimbMatrix applies the per-arm reachSign.
   */
  readonly outReach?: Float32Array | undefined;
  /** Per-figure SoA slot output (T122/V87): the stable identity the render lane hashes for per-instance tint. */
  readonly outSlot?: Float32Array | undefined;
  /** Real frame delta (seconds) used to advance each live slot's gait phase at its per-state rate (T111/V75). */
  readonly dtSeconds: number;
  /** Per-state gait tunables driving the phase rate (and carried through to the per-part transform) (T111/V75). */
  readonly gait: LimbGaitConfig;
}

export interface LimbPackResult {
  /** Number of limbed instances written (compacted to the front; <= capacity). */
  readonly liveCount: number;
}

/**
 * Compact LIVE, limbed-tier (simTier <= maxSimTier) zombies into the per-instance input arrays. Dead and
 * horde/abstract-tier (simTier > maxSimTier) slots are skipped; the box path renders those. Live instances
 * are compacted to the front and the count is CAPPED at `capacity` (the limbed budget) — beyond the budget
 * extra figures are simply not promoted this frame (distance/score LOD selection lands in T30). No throw:
 * the budget is a pool cap, not a correctness invariant.
 *
 * T111/V75: ALSO reads the per-slot ZombieState + velocity (→ speed) and advances a render-side per-SLOT gait
 * phase accumulator (`phaseState`, sized to `count` / SoA capacity, seeded by the caller with per-slot offsets
 * so figures are never in lockstep) at the per-state rate (`gaitPhaseRateHz`). The advanced phase + the slot's
 * state + speed are written to the compacted outputs (`outPhase`/`outState`/`outSpeed`) so the per-part
 * transform can pick the swing/bob/reach per zombie. The SoA `animPhase` is sim-owned + unadvanced, so the
 * limb tier owns its own phase here; this NEVER writes back to the sim (V3).
 */
export function packLimbInputs(
  views: FieldViews,
  outPose: Float32Array,
  outScale: Float32Array,
  outAnatomy: Uint32Array,
  outPhase: Float32Array,
  outState: Uint8Array,
  outSpeed: Float32Array,
  phaseState: Float32Array,
  reachState: Float32Array,
  opts: LimbPackOptions,
): LimbPackResult {
  const { count, capacity, variationCount, scaleMin, scaleMax, maxSimTier, figureMask, visibility, outFade, outReach, outSlot, dtSeconds, gait } = opts;
  if (count < 0) throw new Error(`count must be >= 0, got ${count}`);
  if (scaleMin > scaleMax) throw new Error(`scale band invalid: ${scaleMin} > ${scaleMax}`);
  if (outPose.length < capacity * FLOATS_PER_LIMB_POSE) {
    throw new Error(`outPose too small: need ${capacity * FLOATS_PER_LIMB_POSE}, got ${outPose.length}`);
  }
  if (outScale.length < capacity) throw new Error(`outScale too small: need ${capacity}, got ${outScale.length}`);
  if (outAnatomy.length < capacity) throw new Error(`outAnatomy too small: need ${capacity}, got ${outAnatomy.length}`);
  if (outPhase.length < capacity) throw new Error(`outPhase too small: need ${capacity}, got ${outPhase.length}`);
  if (outState.length < capacity) throw new Error(`outState too small: need ${capacity}, got ${outState.length}`);
  if (outSpeed.length < capacity) throw new Error(`outSpeed too small: need ${capacity}, got ${outSpeed.length}`);
  if (phaseState.length < count) throw new Error(`phaseState too small: need ${count}, got ${phaseState.length}`);
  if (reachState.length < count) throw new Error(`reachState too small: need ${count}, got ${reachState.length}`);
  if (outReach && outReach.length < capacity) throw new Error(`outReach too small: need ${capacity}, got ${outReach.length}`);
  if (outSlot && outSlot.length < capacity) throw new Error(`outSlot too small: need ${capacity}, got ${outSlot.length}`);

  const alive = requireView<Uint8Array>(views, 'alive');
  const position = requireView<Float32Array>(views, 'position');
  const heading = requireView<Float32Array>(views, 'heading');
  const simTier = requireView<Uint8Array>(views, 'simTier');
  const anatomyFlags = requireView<Uint32Array>(views, 'anatomyFlags');
  const state = requireView<Uint8Array>(views, 'state');
  const velocity = requireView<Float32Array>(views, 'velocity');

  let live = 0;
  // `rank` counts limbed-eligible alive slots in slot order (independent of the vision cull) so it matches
  // packCrowdInputs' figureRank exactly: the first `capacity` eligible slots belong to the figure pool, the
  // rest fall through to the box path there. A vision-culled figure still consumes its rank (so the box does
  // not redraw it) but writes no instance.
  let rank = 0;
  for (let slot = 0; slot < count; slot++) {
    if (alive[slot]! === 0) continue;
    if (figureMask) {
      // Distance-ranked partition: only the slots the shared mask marks as near figures are drawn here; the
      // rest (including over-budget eligible ones) are boxes. Identical mask the box + rigged passes consult.
      if (figureMask[slot] !== 1) continue;
      if (live >= capacity) continue; // pool safety — the mask never marks more than the budget (<= capacity)
    } else {
      if (simTier[slot]! > maxSimTier) continue; // not limbed-eligible → drawn as a box
      if (rank++ >= capacity) continue; // beyond the pool cap (V13) → the box path renders this overflow figure
    }

    // Vision-cone fog-of-war (T96) + perception v2 (V62): read the precomputed per-slot reveal when the scene
    // supplied one (cone+near+memory+noise); else fall back to the pure cone fade.
    let fade = 1;
    if (visibility) {
      fade = visibility.reveal ? visibility.reveal[slot]! : visionCullFade(position[slot * 3]!, position[slot * 3 + 2]!, visibility);
      if (fade <= 0) continue;
    }

    const seed = variationSeed(slot, variationCount);
    const p = live * FLOATS_PER_LIMB_POSE;
    outPose[p] = position[slot * 3]!;
    outPose[p + 1] = position[slot * 3 + 1]!;
    outPose[p + 2] = position[slot * 3 + 2]!;
    outPose[p + 3] = heading[slot]!;
    // V65: FULL scale always — the reveal fade is per-instance ALPHA (outFade), so figures fade in/out without
    // any height/scale change (dropping instanceColor freed the vertex buffer instFade needs on the limb mesh).
    outScale[live] = variationScale(seed, variationCount, scaleMin, scaleMax);
    if (outFade) outFade[live] = fade;
    outAnatomy[live] = anatomyFlags[slot]!;

    // T111/V75: derive planar speed (the gait is driven by horizontal locomotion, not the vertical bob) and
    // advance THIS slot's gait phase at its per-state rate. phaseState is per-SLOT (stable identity), seeded
    // by the caller with a per-slot offset, so figures never march in lockstep. Wrap to [0,1) without alloc.
    const st = state[slot]!;
    const vx = velocity[slot * 3]!;
    const vz = velocity[slot * 3 + 2]!;
    const speed = Math.hypot(vx, vz);
    let ph = phaseState[slot]! + gaitPhaseRateHz(st, speed, gait) * dtSeconds;
    ph -= Math.floor(ph);
    phaseState[slot] = ph;
    outPhase[live] = ph;
    outState[live] = st;
    outSpeed[live] = speed;

    // T122/V87: ease THIS slot's forward arm-reach toward its per-state target so the chase/attack arm-raise blends
    // in (and drops out) smoothly instead of snapping when the zombie notices/loses the player. Per-SLOT (stable
    // identity, like phaseState); exponential approach at reachBlendHz, allocation-free + deterministic given dt.
    if (outReach) {
      const target = stateReachTarget(st, ph, gait);
      const k = clamp01(gait.reachBlendHz * dtSeconds);
      const r = reachState[slot]! + (target - reachState[slot]!) * k;
      reachState[slot] = r;
      outReach[live] = r;
    }
    if (outSlot) outSlot[live] = slot;
    live++;
  }
  return { liveCount: live };
}

/** Per-part placement: box dims, local offset from the feet origin, joint pivot, and swing/reach signs (0 = static). */
export interface LimbPartPlacement {
  /** Local center offset from the ground origin (pre-scale), meters [x,y,z]. */
  readonly offset: readonly [number, number, number];
  /**
   * Distance (pre-scale meters) from the box CENTER up to the JOINT the limb swings from (half the box height:
   * hip atop a leg, shoulder atop an arm). The swing/reach rotation pivots about this joint, NOT the limb
   * midpoint (T122/V87), so the joint stays anchored to the torso while the segment swings below/around it.
   * 0 = the part never swings (torso/head) → the pivot reduces to the plain centered transform.
   */
  readonly pivotLen: number;
  /** Walk-phase swing sign about local X (arms/legs counter-swing); 0 keeps the part rigid. */
  readonly swingSign: number;
  /** ATTACK forward-reach sign about local X (T111/V75); non-zero only on arms (same sign on both). 0 = no reach. */
  readonly reachSign: number;
}

/**
 * Compose one column-major instance mat4 for a body part into `out` at byte-free element `base`.
 * Transform = Translate(worldCenter) * RotY(heading) * RotX(angle) * Scale(scale), where the local-X rotation
 * angle = swing*swingSign + reach*reachSign: the gait counter-swing (legs+arms opposite) PLUS the attack/chase
 * reach (arms only, both forward — T111/V75, T122/V87).
 *
 * JOINT PIVOT (T122/V87): the limb rotates about its JOINT (the top of the box — hip for a leg, shoulder for an
 * arm), NOT its own center. With pivot length L = `placement.pivotLen` (0 for the rigid torso/head), the box
 * center in the rig-local frame is the joint MINUS the rotated half-segment: localCenter = (ox, oy + L*(1-cosθ),
 * oz - L*sinθ), θ = the local-X angle. At θ=0 this is the plain `offset`, and the joint (ox, oy+L, oz) stays put
 * for every θ — so hips/shoulders stay anchored to the torso while the segment swings below/around them. The
 * basis (columns 0-2) is unchanged; only the translation (column 3) accounts for the pivot. worldCenter =
 * basePos + RotY(heading) * (localCenter * scale) + vertical bob.
 *
 * When `visible` is false (the part's region is severed, V17), all 16 elements are zeroed → a degenerate
 * (invisible) instance, so dismemberment READS without removing/repacking the instance. Pure math; no GPU dep.
 */
export function composeLimbMatrix(
  out: Float32Array,
  base: number,
  basePos: ArrayLike<number>,
  heading: number,
  scale: number,
  placement: LimbPartPlacement,
  swing: number,
  reach: number,
  bobY: number,
  visible: boolean,
): void {
  if (!visible) {
    for (let i = 0; i < FLOATS_PER_MAT4; i++) out[base + i] = 0;
    return;
  }
  // The rig's lateral axis is local +X (shoulders/hips) and its FORWARD is local +Z (depth). Yaw maps local
  // +Z → the movement heading, i.e. facing = heading - 90° (was mapping local +X → heading, pointing the
  // shoulders along travel → figures walked sideways). The local-X rotation stays about the lateral axis, so
  // the gait reads as forward-back stepping. Must stay in lockstep with the box crowd compute's `facing`.
  const facing = heading - Math.PI / 2;
  const cy = Math.cos(facing);
  const sy = -Math.sin(facing);
  // Gait counter-swing (legs+arms opposite via swingSign) + the attack forward reach (arms only via reachSign;
  // a negative product rotates the arm's hand toward local +Z / the heading → a forward lunge, T111/V75).
  const sw = swing * placement.swingSign + reach * placement.reachSign;
  const ca = Math.cos(sw);
  const sa = Math.sin(sw);
  const [ox, oy, oz] = placement.offset;
  // JOINT PIVOT (T122/V87): shift the box center so the limb rotates about its joint (top of the box) instead of
  // its midpoint. localCenter = joint - RotX(sw)*(0,L,0) = (ox, oy + L*(1-cosθ), oz - L*sinθ). L=0 → plain offset.
  const L = placement.pivotLen;
  const lx = ox;
  const ly = oy + L * (1 - ca);
  const lz = oz - L * sa;

  // Column 0 (rotated X axis * scale)
  out[base] = cy * scale;
  out[base + 1] = 0;
  out[base + 2] = -sy * scale;
  out[base + 3] = 0;
  // Column 1 (rotated Y axis * scale)
  out[base + 4] = sy * sa * scale;
  out[base + 5] = ca * scale;
  out[base + 6] = cy * sa * scale;
  out[base + 7] = 0;
  // Column 2 (rotated Z axis * scale)
  out[base + 8] = sy * ca * scale;
  out[base + 9] = -sa * scale;
  out[base + 10] = cy * ca * scale;
  out[base + 11] = 0;
  // Column 3 (world translation) — pivot-adjusted local center, yawed by heading, plus the body bob.
  out[base + 12] = basePos[0]! + (cy * lx + sy * lz) * scale;
  out[base + 13] = basePos[1]! + ly * scale + bobY;
  out[base + 14] = basePos[2]! + (-sy * lx + cy * lz) * scale;
  out[base + 15] = 1;
}

/** Walk-cycle helpers shared by Crowd; pure so the swing/bob curve is unit-testable. */
export function walkSwing(phase: number, amplitudeRadians: number): number {
  return Math.sin(phase * TAU) * amplitudeRadians;
}
export function walkBob(phase: number, amplitudeMeters: number): number {
  // Double-frequency vertical bob (two steps per stride) reads as a gait without limb IK.
  return Math.abs(Math.sin(phase * TAU)) * amplitudeMeters;
}
