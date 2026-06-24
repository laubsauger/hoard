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
/** 4 floats of per-instance meta input: [scale, variationSeed, archetype, revealAlpha (V65, was animState)]. */
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
   * Precomputed per-slot figure membership (1 = drawn as a near FIGURE by the limb/rigged path, so the box
   * SKIPS it; 0 = the box draws it). DISTANCE-ranked (the nearest `limbedBudget` eligible slots to the player),
   * so the box LOD lands on the FAR overflow — not arbitrary slot-order members, which made boxes appear on
   * near zombies while far ones stayed figures. When absent, falls back to the legacy slot-order rank.
   */
  readonly figureMask?: Uint8Array | undefined;
  /**
   * Optional vision-cone fog-of-war cull (T96): hide members outside the player's forward cone / range /
   * line-of-sight and fade those near the edges. Undefined = no cull (the whole horde draws).
   */
  readonly visibility?: VisionCull | undefined;
}

/**
 * The shared figure/box partition (T30 LOD), DISTANCE-ranked. Returns a per-slot mask where 1 = this alive,
 * limbed-eligible (simTier <= maxSimTier) slot is among the `budget` NEAREST to the player → drawn as a near
 * figure (limb/rigged path); 0 = drawn as a box. The box, limb, AND rigged passes all consult this ONE mask,
 * so they partition the live set identically AND the boxes fall on the far overflow rather than on whichever
 * slots came first in SoA order (the "boxes on the nearest zombies" bug). Pure: the caller owns the player
 * position; ties break by slot index for replay-stable (V26) selection. Pass `out` to reuse a scratch buffer.
 */
export function computeFigureMask(
  views: FieldViews,
  count: number,
  playerX: number,
  playerZ: number,
  maxSimTier: number,
  budget: number,
  out?: Uint8Array,
): Uint8Array {
  const mask = out && out.length >= count ? out : new Uint8Array(count);
  mask.fill(0, 0, count);
  if (maxSimTier < 0 || budget <= 0) return mask; // limbed split disabled → everything is a box
  const alive = requireView<Uint8Array>(views, 'alive');
  const simTier = requireView<Uint8Array>(views, 'simTier');
  const position = requireView<Float32Array>(views, 'position');
  const eligible: number[] = [];
  for (let s = 0; s < count; s++) {
    if (alive[s]! === 0 || simTier[s]! > maxSimTier) continue;
    eligible.push(s);
  }
  if (eligible.length <= budget) {
    for (const s of eligible) mask[s] = 1;
    return mask;
  }
  // More eligible than the budget → keep the NEAREST `budget` (nearest-first, slot tiebreak for determinism).
  eligible.sort((a, b) => {
    const dxa = position[a * 3]! - playerX;
    const dza = position[a * 3 + 2]! - playerZ;
    const dxb = position[b * 3]! - playerX;
    const dzb = position[b * 3 + 2]! - playerZ;
    const da = dxa * dxa + dza * dza;
    const db = dxb * dxb + dzb * dzb;
    return da !== db ? da - db : a - b;
  });
  for (let i = 0; i < budget; i++) mask[eligible[i]!] = 1;
  return mask;
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
 * Stable [0,1) hash of a slot + salt — a FINER-grained companion to the bucketed `variationSeed` for per-instance
 * tint / jitter (T122). The salt decorrelates independent visual channels (hue vs value vs scale) from the same
 * slot; the integer mix then maps to a float in [0,1). Stable per slot across frames + replay-deterministic (V26,
 * V87) — NEVER `Math.random()` per frame.
 */
export function variationHash01(slot: number, salt: number): number {
  // lowbias32 integer finalizer — well-distributed (near-uniform) + cheap; the salt decorrelates channels.
  let x = (slot >>> 0) ^ Math.imul(salt >>> 0, 0x9e3779b9);
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

function clamp01t(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Write a SUBTLE, stable per-instance TINT of a base RGB colour into `out[o..o+2]` — the crowd colour variation
 * (T122/V87). `hueJit`/`valJit` ∈ [-1,1] (from `variationHash01`) shift HUE (warm↔cool via an opposing R/B skew)
 * and VALUE (brightness) by the small `hueSpread`/`valSpread` fractions, so no two figures read identically while
 * the jitter stays gentle. PURE + deterministic — same inputs → same tint every frame (V26); allocation-free
 * (writes into a caller-owned array, V24). Channels are clamped to [0,1].
 */
export function variationTint(
  baseR: number,
  baseG: number,
  baseB: number,
  hueJit: number,
  valJit: number,
  hueSpread: number,
  valSpread: number,
  out: Float32Array | number[],
  o = 0,
): void {
  const v = 1 + valJit * valSpread;
  const h = hueJit * hueSpread;
  out[o] = clamp01t(baseR * v * (1 + h));
  out[o + 1] = clamp01t(baseG * v);
  out[o + 2] = clamp01t(baseB * v * (1 - h));
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
    figureMask,
    visibility,
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
  const simTier = limbedMaxSimTier >= 0 ? requireView<Uint8Array>(views, 'simTier') : undefined;

  let live = 0;
  // Limbed-eligible alive slots seen so far, in slot order. This rank decides figure-vs-box membership and is
  // counted IDENTICALLY here and in packLimbInputs (regardless of vision cull) so the two paths partition the
  // live set exactly — every alive zombie is drawn by exactly one path, and over-budget figures fall through
  // to a box here rather than disappearing (§B culling fix).
  let figureRank = 0;
  for (let slot = 0; slot < count; slot++) {
    if (alive[slot]! === 0) continue;
    if (figureMask) {
      // Distance-ranked partition: this slot is a near figure → the limb/rigged path draws it, skip the box.
      if (figureMask[slot] === 1) continue;
    } else if (simTier && simTier[slot]! <= limbedMaxSimTier) {
      // Legacy slot-order fallback (no mask supplied — e.g. unit tests).
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
    // V65: per-instance reveal ALPHA rides in meta.w (formerly animState, which the GPU never reads) so the
    // box crowd fades via opacity with NO extra vertex buffer — a separate fade attribute pushed the box to 9
    // vertex buffers, over the WebGPU limit of 8. The material's opacityNode reads metaBuffer.toAttribute().w.
    outMeta[m + 3] = fade;

    live++;
    if (live > capacity) throw new Error(`live instance count exceeded capacity ${capacity}`);
  }
  return { liveCount: live };
}
