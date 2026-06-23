// T9 / V2 / V3 — pure SoA -> GPU-input packing. NO per-zombie object/shader; one InstancedMesh family
// reads the frozen ZOMBIE_FIELDS SoA views and we compact the LIVE instances into a small set of
// per-instance INPUT arrays (pose + meta). The actual instance transform (mat4) is assembled on the GPU
// in a TSL compute shader from these inputs (V2 "GPU-readable animation data") — the CPU no longer builds
// matrices. This function constructs NO GPU object and is fully unit-testable: it only fills plain typed
// arrays the renderer later wraps in storage buffers.

import type { FieldViews } from '../../game/core/contracts/soa';
import { visionCullFade, type VisionCull } from './visionCull';

/** 4 floats of per-instance pose input: [posX, posY, posZ, headingRadians]. */
export const FLOATS_PER_POSE = 4;
/** 4 floats of per-instance meta input: [scale, variationSeed, archetype, animState]. */
export const FLOATS_PER_META = 4;

function requireView<T>(views: FieldViews, name: string): T {
  const v = views[name];
  if (!v) throw new Error(`SoA view '${name}' missing — packing requires the frozen ZOMBIE_FIELDS layout`);
  return v as unknown as T;
}

/** Deterministic small hash -> [0, count) for stable per-slot visual variation seeds. */
export function variationSeed(slot: number, count: number): number {
  if (!Number.isInteger(count) || count <= 0) throw new Error(`variation count must be a positive integer, got ${count}`);
  // xorshift-ish integer mix, stable across runs (V26 determinism-friendly).
  let h = slot >>> 0;
  h ^= h << 13;
  h ^= h >>> 17;
  h ^= h << 5;
  return (h >>> 0) % count;
}

export interface PackOptions {
  /** Number of SoA slots to scan (<= capacity of the SoA). */
  readonly count: number;
  /** Instance buffer capacity (out arrays hold capacity * floats-per). */
  readonly capacity: number;
  readonly variationCount: number;
  readonly scaleMin: number;
  readonly scaleMax: number;
  /**
   * Slots with simTier <= this are ELIGIBLE for the limbed figure path (T72/V13). -1 (default) disables the
   * limbed split → the box draws every tier. The figure path renders the first `limbedBudget` eligible slots;
   * eligible slots BEYOND that budget fall through and are drawn as boxes HERE (see `limbedBudget`).
   */
  readonly limbedMaxSimTier?: number;
  /**
   * Max figures the limbed path renders this frame (the pool cap, matched to packLimbInputs). Limbed-eligible
   * slots beyond this budget are rendered as boxes by this function instead of vanishing. This closes the
   * culling gap (§B) where over-budget NEAR zombies (low simTier) were drawn by NEITHER path while far horde
   * boxes kept drawing. Default Infinity (no overflow). Must stay in lockstep with packLimbInputs' capacity.
   */
  readonly limbedBudget?: number;
  /**
   * Optional vision-cone fog-of-war cull (T96): hide members outside the player's forward cone / range /
   * line-of-sight and fade those near the edges. Undefined = no cull (the whole horde draws).
   */
  readonly visibility?: VisionCull | undefined;
  /**
   * Optional per-instance OPACITY output (V65). When provided, the reveal `fade` (0..1 from cone/near/memory/
   * noise) is written here PER LIVE INSTANCE instead of being baked into the instance SCALE — so the renderer
   * fades members in/out via ALPHA (a smooth blend) rather than shrinking them (which read as jank). Compacted
   * to the front like pose/meta; entries past liveCount are stale (mesh.count bounds the draw).
   */
  readonly outFade?: Float32Array | undefined;
}

export interface PackResult {
  /** Number of LIVE instances written (compacted to the front of the out arrays). */
  readonly liveCount: number;
}

/** Deterministic per-slot scale within [scaleMin, scaleMax] derived from the variation seed. */
export function variationScale(seed: number, variationCount: number, scaleMin: number, scaleMax: number): number {
  const range = scaleMax - scaleMin;
  return variationCount > 1 ? scaleMin + range * (seed / (variationCount - 1)) : scaleMin + range * 0.5;
}

/**
 * Pack live zombies from SoA views into the per-instance GPU INPUT arrays (pose + meta). Dead slots
 * (alive == 0) are skipped and live instances are compacted to the front, so the caller sets
 * InstancedMesh.count = liveCount and the compute shader assembles transforms for index 0..liveCount-1.
 * Throws if live instances would exceed capacity (V4 — no silent drop).
 */
export function packCrowdInputs(
  views: FieldViews,
  outPose: Float32Array,
  outMeta: Float32Array,
  opts: PackOptions,
): PackResult {
  const {
    count,
    capacity,
    variationCount,
    scaleMin,
    scaleMax,
    limbedMaxSimTier = -1,
    limbedBudget = Infinity,
    visibility,
    outFade,
  } = opts;
  if (count < 0 || count > capacity) throw new Error(`count ${count} exceeds capacity ${capacity}`);
  if (outPose.length < capacity * FLOATS_PER_POSE) {
    throw new Error(`outPose too small: need ${capacity * FLOATS_PER_POSE}, got ${outPose.length}`);
  }
  if (outMeta.length < capacity * FLOATS_PER_META) {
    throw new Error(`outMeta too small: need ${capacity * FLOATS_PER_META}, got ${outMeta.length}`);
  }
  if (scaleMin > scaleMax) throw new Error(`scale band invalid: ${scaleMin} > ${scaleMax}`);

  const alive = requireView<Uint8Array>(views, 'alive');
  const position = requireView<Float32Array>(views, 'position');
  const heading = requireView<Float32Array>(views, 'heading');
  const archetype = requireView<Uint16Array>(views, 'archetype');
  const animState = requireView<Uint8Array>(views, 'animState');
  const simTier = limbedMaxSimTier >= 0 ? requireView<Uint8Array>(views, 'simTier') : undefined;

  let live = 0;
  // Limbed-eligible alive slots seen so far, in slot order. This rank decides figure-vs-box membership and is
  // counted IDENTICALLY here and in packLimbInputs (regardless of vision cull) so the two paths partition the
  // live set exactly — every alive zombie is drawn by exactly one path, and over-budget figures fall through
  // to a box here rather than disappearing (§B culling fix).
  let figureRank = 0;
  for (let slot = 0; slot < count; slot++) {
    if (alive[slot]! === 0) continue;
    if (simTier && simTier[slot]! <= limbedMaxSimTier) {
      if (figureRank < limbedBudget) {
        figureRank++;
        continue; // claimed by the limbed figure path (drawn or vision-culled there)
      }
      // else: over-budget figure → it FALLS THROUGH to the box below (no vanish).
    }

    // Vision-cone fog-of-war (T96) + perception v2 (V62): skip members the reveal hides; fade edges via alpha (V65).
    // When the scene precomputed a per-slot reveal (cone+near+memory+noise), read it; else fall back to the pure
    // cone fade so callers that pass only a wedge keep working.
    let fade = 1;
    if (visibility) {
      fade = visibility.reveal ? visibility.reveal[slot]! : visionCullFade(position[slot * 3]!, position[slot * 3 + 2]!, visibility);
      if (fade <= 0) continue;
    }

    const seed = variationSeed(slot, variationCount);
    // V65: keep FULL scale — the reveal `fade` no longer shrinks the instance. When an outFade buffer is given
    // it carries the fade as per-instance alpha (smooth blend); legacy callers without it get full-size members
    // (the reveal still hard-skips fully-hidden ones via `fade <= 0` above).
    const sc = variationScale(seed, variationCount, scaleMin, scaleMax);

    const p = live * FLOATS_PER_POSE;
    outPose[p] = position[slot * 3]!;
    outPose[p + 1] = position[slot * 3 + 1]!;
    outPose[p + 2] = position[slot * 3 + 2]!;
    outPose[p + 3] = heading[slot]!;

    const m = live * FLOATS_PER_META;
    outMeta[m] = sc;
    outMeta[m + 1] = seed;
    outMeta[m + 2] = archetype[slot]!;
    outMeta[m + 3] = animState[slot]!;
    if (outFade) outFade[live] = fade;

    live++;
    if (live > capacity) throw new Error(`live instance count exceeded capacity ${capacity}`);
  }
  return { liveCount: live };
}
