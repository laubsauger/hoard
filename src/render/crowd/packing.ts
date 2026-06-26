// T9 / T140 / V2 / V3 — pure SoA helpers for the crowd render lanes. NO per-zombie object/shader. The crowd is
// drawn by exactly TWO lanes that share ONE distance partition computed here: the RIGGED GPU-skinned lane
// (near/mid) and the baked billboard IMPOSTOR lane (far). There is NO box LOD and NO count budget — every
// in-view alive zombie within the rigged distance is a rigged figure; the rest are impostors. This module is
// GPU-free + fully unit-testable: it only reads the frozen ZOMBIE_FIELDS SoA views and fills plain typed arrays.

import type { FieldViews } from '../../game/core/contracts/soa';

function requireView<T>(views: FieldViews, name: string): T {
  const v = views[name];
  if (!v) throw new Error(`SoA view '${name}' missing — crowd packing requires the frozen ZOMBIE_FIELDS layout`);
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

/** Mask byte for a slot drawn by the near RIGGED GPU-skinned lane. */
export const BAND_RIGGED = 1;
/** Mask byte for a slot drawn by the far billboard IMPOSTOR lane. */
export const BAND_IMPOSTOR = 0;

/**
 * The crowd's ONE shared LOD partition (T140), by DISTANCE — not a count budget. For every ALIVE slot, mark it
 * `BAND_RIGGED` (1) when its planar distance to the anchor (player/camera XZ) is within `riggedMaxDist`, else
 * `BAND_IMPOSTOR` (0). Both lanes (rigged + impostor) consult this ONE mask so the live set is partitioned
 * identically and each alive zombie is claimed by EXACTLY ONE lane (§B). Dead slots are 0 but never drawn (both
 * lanes skip alive==0). PURE: the caller owns the anchor; allocation-free when an `out` scratch is reused.
 *
 * `slotCount` is the SoA SLOT-SCAN EXTENT (= capacity), NOT the alive population — the SoA is a sparse free-list,
 * so an alive zombie may sit at any slot index < capacity. Scan the full extent (dead slots are skipped) so a
 * high-index alive zombie is never silently dropped from the render (the invisible-enemy bug).
 */
export function computeDistanceBand(
  views: FieldViews,
  slotCount: number,
  anchorX: number,
  anchorZ: number,
  riggedMaxDist: number,
  out?: Uint8Array,
): Uint8Array {
  const mask = out && out.length >= slotCount ? out : new Uint8Array(slotCount);
  mask.fill(BAND_IMPOSTOR, 0, slotCount);
  if (riggedMaxDist <= 0) return mask; // everything is an impostor
  const alive = requireView<Uint8Array>(views, 'alive');
  const position = requireView<Float32Array>(views, 'position');
  const r2 = riggedMaxDist * riggedMaxDist;
  for (let s = 0; s < slotCount; s++) {
    if (alive[s]! === 0) continue;
    const dx = position[s * 3]! - anchorX;
    const dz = position[s * 3 + 2]! - anchorZ;
    mask[s] = dx * dx + dz * dz <= r2 ? BAND_RIGGED : BAND_IMPOSTOR;
  }
  return mask;
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
