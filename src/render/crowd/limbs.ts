// T72 / V2 / V3 / V13 / V17 — block-limbed render path (pure CPU core).
// Hero (simTier 0) + active-crowd (simTier 1) zombies must read as FIGURES so dismemberment is VISIBLE,
// so each is composed from a small fixed set of body-part boxes (head/torso/armL/armR/legL/legR). This
// module owns the PURE, GPU-free core: it (a) compacts the limbed-tier slots out of the SoA into per-
// instance input arrays (capped to the limbed budget — a render POOL cap, no throw), and (b) composes the
// per-(instance,part) transform mat4 from the zombie pose + a simple walk swing/bob. The Crowd class wires
// these floats into one InstancedMesh PER PART (NO per-zombie object/mesh, V2). Reads SoA only (V3); never
// writes back to the sim. Kept three-free so it unit-tests without a GPU device.

import type { FieldViews } from '../../game/core/contracts/soa';
import { variationScale, variationSeed } from './packing';
import { visionCullFade, type VisionCull } from './visionCull';

const TAU = Math.PI * 2;

/** Floats of per-instance pose input: [posX, posY, posZ, headingRadians]. */
export const FLOATS_PER_LIMB_POSE = 4;
/** Elements written per composed instance transform (one column-major mat4). */
export const FLOATS_PER_MAT4 = 16;

function requireView<T>(views: FieldViews, name: string): T {
  const v = views[name];
  if (!v) throw new Error(`SoA view '${name}' missing — limbed crowd requires the frozen ZOMBIE_FIELDS layout`);
  return v as unknown as T;
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
   * Optional vision-cone fog-of-war cull (T96): hide figures outside the player's forward cone / range /
   * line-of-sight and fade those near the edges. A culled figure keeps its budget RANK (so the box path does
   * not redraw it) but writes no instance. Undefined = no cull.
   */
  readonly visibility?: VisionCull | undefined;
  /** Per-figure reveal ALPHA output (V65): the fade is written here, NOT baked into scale, so figures fade
   *  in/out instead of shrinking. Compacted to the front like the other outputs. */
  readonly outFade?: Float32Array | undefined;
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
 */
export function packLimbInputs(
  views: FieldViews,
  outPose: Float32Array,
  outScale: Float32Array,
  outAnatomy: Uint32Array,
  outPhase: Float32Array,
  opts: LimbPackOptions,
): LimbPackResult {
  const { count, capacity, variationCount, scaleMin, scaleMax, maxSimTier, visibility, outFade } = opts;
  if (count < 0) throw new Error(`count must be >= 0, got ${count}`);
  if (scaleMin > scaleMax) throw new Error(`scale band invalid: ${scaleMin} > ${scaleMax}`);
  if (outPose.length < capacity * FLOATS_PER_LIMB_POSE) {
    throw new Error(`outPose too small: need ${capacity * FLOATS_PER_LIMB_POSE}, got ${outPose.length}`);
  }
  if (outScale.length < capacity) throw new Error(`outScale too small: need ${capacity}, got ${outScale.length}`);
  if (outAnatomy.length < capacity) throw new Error(`outAnatomy too small: need ${capacity}, got ${outAnatomy.length}`);
  if (outPhase.length < capacity) throw new Error(`outPhase too small: need ${capacity}, got ${outPhase.length}`);

  const alive = requireView<Uint8Array>(views, 'alive');
  const position = requireView<Float32Array>(views, 'position');
  const heading = requireView<Float32Array>(views, 'heading');
  const simTier = requireView<Uint8Array>(views, 'simTier');
  const anatomyFlags = requireView<Uint32Array>(views, 'anatomyFlags');
  const animPhase = requireView<Float32Array>(views, 'animPhase');

  let live = 0;
  // `rank` counts limbed-eligible alive slots in slot order (independent of the vision cull) so it matches
  // packCrowdInputs' figureRank exactly: the first `capacity` eligible slots belong to the figure pool, the
  // rest fall through to the box path there. A vision-culled figure still consumes its rank (so the box does
  // not redraw it) but writes no instance.
  let rank = 0;
  for (let slot = 0; slot < count; slot++) {
    if (alive[slot]! === 0) continue;
    if (simTier[slot]! > maxSimTier) continue; // not limbed-eligible → drawn as a box
    if (rank++ >= capacity) continue; // beyond the pool cap (V13) → the box path renders this overflow figure

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
    outPhase[live] = animPhase[slot]!;
    live++;
  }
  return { liveCount: live };
}

/** Per-part placement: box dims, local offset from the feet origin, and a walk-swing sign (0 = static). */
export interface LimbPartPlacement {
  /** Local center offset from the ground origin (pre-scale), meters [x,y,z]. */
  readonly offset: readonly [number, number, number];
  /** Walk-phase swing sign about local X (arms/legs counter-swing); 0 keeps the part rigid. */
  readonly swingSign: number;
}

/**
 * Compose one column-major instance mat4 for a body part into `out` at byte-free element `base`.
 * Transform = Translate(worldCenter) * RotY(heading) * RotX(swing) * Scale(scale), where
 * worldCenter = basePos + RotY(heading) * (offset * scale) + vertical bob. When `visible` is false (the
 * part's region is severed, V17), all 16 elements are zeroed → a degenerate (invisible) instance, so
 * dismemberment READS without removing/repacking the instance. Pure math; no three/GPU dependency.
 */
export function composeLimbMatrix(
  out: Float32Array,
  base: number,
  basePos: ArrayLike<number>,
  heading: number,
  scale: number,
  placement: LimbPartPlacement,
  swing: number,
  bobY: number,
  visible: boolean,
): void {
  if (!visible) {
    for (let i = 0; i < FLOATS_PER_MAT4; i++) out[base + i] = 0;
    return;
  }
  // The rig's lateral axis is local +X (shoulders/hips) and its FORWARD is local +Z (depth). Yaw maps local
  // +Z → the movement heading, i.e. facing = heading - 90° (was mapping local +X → heading, pointing the
  // shoulders along travel → figures walked sideways). The walk swing stays about local X (lateral), so it
  // reads as forward-back stepping. Must stay in lockstep with the box crowd compute's `facing`.
  const facing = heading - Math.PI / 2;
  const cy = Math.cos(facing);
  const sy = -Math.sin(facing);
  const sw = swing * placement.swingSign;
  const ca = Math.cos(sw);
  const sa = Math.sin(sw);
  const [ox, oy, oz] = placement.offset;

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
  // Column 3 (world translation)
  out[base + 12] = basePos[0]! + (cy * ox + sy * oz) * scale;
  out[base + 13] = basePos[1]! + oy * scale + bobY;
  out[base + 14] = basePos[2]! + (-sy * ox + cy * oz) * scale;
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
