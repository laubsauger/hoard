// T9 / V2 / V3 — pure SoA -> instance-buffer packing. NO per-zombie object/shader; one InstancedMesh
// family reads the frozen ZOMBIE_FIELDS SoA views and we pack a single instance-matrix + variation buffer.
// This function constructs NO GPU object and is fully unit-testable. Matrices match THREE.Matrix4.compose
// (column-major) so they drop straight into InstancedMesh.instanceMatrix.

import type { FieldViews } from '../../game/core/contracts/soa';

/** 16 floats per instance (a column-major mat4), matching InstancedMesh.instanceMatrix layout. */
export const FLOATS_PER_MATRIX = 16;
/** 4 floats of per-instance variation: [variationSeed, archetype, animState, animPhase]. */
export const FLOATS_PER_VARIATION = 4;

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
}

export interface PackResult {
  /** Number of LIVE instances written (compacted to the front of the out arrays). */
  readonly liveCount: number;
}

/**
 * Pack live zombies from SoA views into a column-major instance-matrix buffer + a variation buffer.
 * Dead slots (alive == 0) are skipped and live instances are compacted to the front, so the caller sets
 * InstancedMesh.count = liveCount. Throws if live instances would exceed capacity (V4 — no silent drop).
 */
export function packInstances(
  views: FieldViews,
  outMatrices: Float32Array,
  outVariation: Float32Array,
  opts: PackOptions,
): PackResult {
  const { count, capacity, variationCount, scaleMin, scaleMax } = opts;
  if (count < 0 || count > capacity) throw new Error(`count ${count} exceeds capacity ${capacity}`);
  if (outMatrices.length < capacity * FLOATS_PER_MATRIX) {
    throw new Error(`outMatrices too small: need ${capacity * FLOATS_PER_MATRIX}, got ${outMatrices.length}`);
  }
  if (outVariation.length < capacity * FLOATS_PER_VARIATION) {
    throw new Error(`outVariation too small: need ${capacity * FLOATS_PER_VARIATION}, got ${outVariation.length}`);
  }
  if (scaleMin > scaleMax) throw new Error(`scale band invalid: ${scaleMin} > ${scaleMax}`);

  const alive = requireView<Uint8Array>(views, 'alive');
  const position = requireView<Float32Array>(views, 'position');
  const heading = requireView<Float32Array>(views, 'heading');
  const archetype = requireView<Uint16Array>(views, 'archetype');
  const animState = requireView<Uint8Array>(views, 'animState');
  const animPhase = requireView<Float32Array>(views, 'animPhase');

  const scaleRange = scaleMax - scaleMin;
  let live = 0;
  for (let slot = 0; slot < count; slot++) {
    if (alive[slot]! === 0) continue;

    const seed = variationSeed(slot, variationCount);
    // Map seed -> [scaleMin, scaleMax] deterministically for per-instance size variation.
    const sc = variationCount > 1 ? scaleMin + scaleRange * (seed / (variationCount - 1)) : scaleMin + scaleRange * 0.5;

    const theta = heading[slot]!;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const px = position[slot * 3]!;
    const py = position[slot * 3 + 1]!;
    const pz = position[slot * 3 + 2]!;

    const m = live * FLOATS_PER_MATRIX;
    // column 0
    outMatrices[m] = c * sc;
    outMatrices[m + 1] = 0;
    outMatrices[m + 2] = -s * sc;
    outMatrices[m + 3] = 0;
    // column 1
    outMatrices[m + 4] = 0;
    outMatrices[m + 5] = sc;
    outMatrices[m + 6] = 0;
    outMatrices[m + 7] = 0;
    // column 2
    outMatrices[m + 8] = s * sc;
    outMatrices[m + 9] = 0;
    outMatrices[m + 10] = c * sc;
    outMatrices[m + 11] = 0;
    // column 3 (translation)
    outMatrices[m + 12] = px;
    outMatrices[m + 13] = py;
    outMatrices[m + 14] = pz;
    outMatrices[m + 15] = 1;

    const vbase = live * FLOATS_PER_VARIATION;
    outVariation[vbase] = seed;
    outVariation[vbase + 1] = archetype[slot]!;
    outVariation[vbase + 2] = animState[slot]!;
    outVariation[vbase + 3] = animPhase[slot]!;

    live++;
    if (live > capacity) throw new Error(`live instance count exceeded capacity ${capacity}`);
  }
  return { liveCount: live };
}
