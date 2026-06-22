// T9 / V2 / V3 — SoA -> instance-matrix packing correctness, compaction, variation, capacity guard.

import { describe, it, expect } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { allocateSoa, ZOMBIE_FIELDS } from '../../game/core/contracts/soa';
import { packInstances, variationSeed, FLOATS_PER_MATRIX, FLOATS_PER_VARIATION } from './packing';

const CAP = 8;

function makeSoa() {
  const soa = allocateSoa(ZOMBIE_FIELDS, CAP);
  return {
    soa,
    alive: soa.views['alive'] as Uint8Array,
    position: soa.views['position'] as Float32Array,
    heading: soa.views['heading'] as Float32Array,
    archetype: soa.views['archetype'] as Uint16Array,
    animState: soa.views['animState'] as Uint8Array,
    animPhase: soa.views['animPhase'] as Float32Array,
  };
}

describe('packInstances (V2/V3)', () => {
  it('packs a live zombie into a column-major matrix matching THREE.Matrix4.compose', () => {
    const s = makeSoa();
    s.alive[0] = 1;
    s.position[0] = 3;
    s.position[1] = 0;
    s.position[2] = -7;
    s.heading[0] = 0.7;

    const matrices = new Float32Array(CAP * FLOATS_PER_MATRIX);
    const variation = new Float32Array(CAP * FLOATS_PER_VARIATION);
    // variationCount 1 + equal scale band => deterministic scale 1, so compose uses unit scale.
    const res = packInstances(s.soa.views, matrices, variation, {
      count: 1,
      capacity: CAP,
      variationCount: 1,
      scaleMin: 1,
      scaleMax: 1,
    });
    expect(res.liveCount).toBe(1);

    const expected = new Matrix4().compose(
      new Vector3(3, 0, -7),
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7),
      new Vector3(1, 1, 1),
    );
    for (let i = 0; i < 16; i++) {
      expect(matrices[i]).toBeCloseTo(expected.elements[i]!, 5);
    }
  });

  it('skips dead slots and compacts live instances to the front', () => {
    const s = makeSoa();
    s.alive[0] = 0; // dead
    s.alive[1] = 1;
    s.position[1 * 3] = 11;
    s.position[1 * 3 + 1] = 2;
    s.position[1 * 3 + 2] = 5;

    const matrices = new Float32Array(CAP * FLOATS_PER_MATRIX);
    const variation = new Float32Array(CAP * FLOATS_PER_VARIATION);
    const res = packInstances(s.soa.views, matrices, variation, {
      count: 2,
      capacity: CAP,
      variationCount: 1,
      scaleMin: 1,
      scaleMax: 1,
    });
    expect(res.liveCount).toBe(1);
    // Live instance occupies index 0; translation is the surviving slot's position.
    expect(matrices[12]).toBeCloseTo(11, 5);
    expect(matrices[13]).toBeCloseTo(2, 5);
    expect(matrices[14]).toBeCloseTo(5, 5);
  });

  it('writes per-instance variation [seed, archetype, animState, animPhase]', () => {
    const s = makeSoa();
    s.alive[0] = 1;
    s.archetype[0] = 4;
    s.animState[0] = 2;
    s.animPhase[0] = 0.5;

    const matrices = new Float32Array(CAP * FLOATS_PER_MATRIX);
    const variation = new Float32Array(CAP * FLOATS_PER_VARIATION);
    packInstances(s.soa.views, matrices, variation, {
      count: 1,
      capacity: CAP,
      variationCount: 16,
      scaleMin: 0.9,
      scaleMax: 1.1,
    });
    expect(variation[0]).toBe(variationSeed(0, 16));
    expect(variation[1]).toBe(4);
    expect(variation[2]).toBe(2);
    expect(variation[3]).toBeCloseTo(0.5, 6);
  });

  it('throws if count exceeds capacity (no silent drop, V4)', () => {
    const s = makeSoa();
    const matrices = new Float32Array(CAP * FLOATS_PER_MATRIX);
    const variation = new Float32Array(CAP * FLOATS_PER_VARIATION);
    expect(() =>
      packInstances(s.soa.views, matrices, variation, {
        count: CAP + 1,
        capacity: CAP,
        variationCount: 1,
        scaleMin: 1,
        scaleMax: 1,
      }),
    ).toThrow();
  });

  it('variationSeed is deterministic and bounded', () => {
    for (let i = 0; i < 100; i++) {
      const v = variationSeed(i, 16);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(16);
      expect(v).toBe(variationSeed(i, 16));
    }
  });
});
