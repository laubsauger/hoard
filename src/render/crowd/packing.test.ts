// T9 / V2 / V3 — SoA -> GPU-input packing: compaction, pose/meta passthrough, variation, capacity guard.
// The instance transform mat4 is assembled on the GPU (compute shader) from these inputs, so the CPU test
// asserts only the pure compaction + per-instance input values.

import { describe, it, expect } from 'vitest';
import { allocateSoa, ZOMBIE_FIELDS } from '../../game/core/contracts/soa';
import {
  packCrowdInputs,
  variationSeed,
  variationScale,
  FLOATS_PER_POSE,
  FLOATS_PER_META,
} from './packing';

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
    simTier: soa.views['simTier'] as Uint8Array,
  };
}

function buffers() {
  return {
    pose: new Float32Array(CAP * FLOATS_PER_POSE),
    meta: new Float32Array(CAP * FLOATS_PER_META),
  };
}

describe('packCrowdInputs (V2/V3)', () => {
  it('packs a live zombie pose [x,y,z,heading] into the input buffer', () => {
    const s = makeSoa();
    s.alive[0] = 1;
    s.position[0] = 3;
    s.position[1] = 0;
    s.position[2] = -7;
    s.heading[0] = 0.7;

    const { pose, meta } = buffers();
    const res = packCrowdInputs(s.soa.views, pose, meta, {
      count: 1,
      capacity: CAP,
      variationCount: 1,
      scaleMin: 1,
      scaleMax: 1,
    });
    expect(res.liveCount).toBe(1);
    expect(pose[0]).toBeCloseTo(3, 6);
    expect(pose[1]).toBeCloseTo(0, 6);
    expect(pose[2]).toBeCloseTo(-7, 6);
    expect(pose[3]).toBeCloseTo(0.7, 6);
    // variationCount 1 + equal scale band => deterministic mid-band scale = 1.
    expect(meta[0]).toBeCloseTo(1, 6);
  });

  it('skips dead slots and compacts live instances to the front', () => {
    const s = makeSoa();
    s.alive[0] = 0; // dead
    s.alive[1] = 1;
    s.position[1 * 3] = 11;
    s.position[1 * 3 + 1] = 2;
    s.position[1 * 3 + 2] = 5;

    const { pose, meta } = buffers();
    const res = packCrowdInputs(s.soa.views, pose, meta, {
      count: 2,
      capacity: CAP,
      variationCount: 1,
      scaleMin: 1,
      scaleMax: 1,
    });
    expect(res.liveCount).toBe(1);
    // Live instance occupies input index 0; pose is the surviving slot's position.
    expect(pose[0]).toBeCloseTo(11, 6);
    expect(pose[1]).toBeCloseTo(2, 6);
    expect(pose[2]).toBeCloseTo(5, 6);
  });

  it('writes per-instance meta [scale, seed, archetype, animState]', () => {
    const s = makeSoa();
    s.alive[0] = 1;
    s.archetype[0] = 4;
    s.animState[0] = 2;

    const { pose, meta } = buffers();
    packCrowdInputs(s.soa.views, pose, meta, {
      count: 1,
      capacity: CAP,
      variationCount: 16,
      scaleMin: 0.9,
      scaleMax: 1.1,
    });
    const seed = variationSeed(0, 16);
    expect(meta[0]).toBeCloseTo(variationScale(seed, 16, 0.9, 1.1), 6);
    expect(meta[1]).toBe(seed);
    expect(meta[2]).toBe(4);
    expect(meta[3]).toBe(2);
  });

  it('throws if count exceeds capacity (no silent drop, V4)', () => {
    const s = makeSoa();
    const { pose, meta } = buffers();
    expect(() =>
      packCrowdInputs(s.soa.views, pose, meta, {
        count: CAP + 1,
        capacity: CAP,
        variationCount: 1,
        scaleMin: 1,
        scaleMax: 1,
      }),
    ).toThrow();
  });

  it('throws on an inverted scale band', () => {
    const s = makeSoa();
    const { pose, meta } = buffers();
    expect(() =>
      packCrowdInputs(s.soa.views, pose, meta, {
        count: 0,
        capacity: CAP,
        variationCount: 1,
        scaleMin: 1.2,
        scaleMax: 0.8,
      }),
    ).toThrow();
  });

  it('with minSimTier set, the box packs ONLY the horde tiers (limbed tiers go to figures, T72)', () => {
    const s = makeSoa();
    // slots 0,1 = hero/active (limbed); slots 2,3 = horde/abstract (box).
    for (let i = 0; i < 4; i++) {
      s.alive[i] = 1;
      s.simTier[i] = i as 0 | 1 | 2 | 3;
      s.position[i * 3] = i;
    }
    const { pose, meta } = buffers();
    const res = packCrowdInputs(s.soa.views, pose, meta, {
      count: 4,
      capacity: CAP,
      variationCount: 1,
      scaleMin: 1,
      scaleMax: 1,
      minSimTier: 2, // limbedMaxSimTier (1) + 1
    });
    expect(res.liveCount).toBe(2);
    // Compacted horde: instance 0 = slot 2 (x=2), instance 1 = slot 3 (x=3).
    expect(pose[0]).toBeCloseTo(2, 6);
    expect(pose[FLOATS_PER_POSE]).toBeCloseTo(3, 6);
  });

  it('without minSimTier the box packs all live slots (default, unchanged)', () => {
    const s = makeSoa();
    for (let i = 0; i < 3; i++) {
      s.alive[i] = 1;
      s.simTier[i] = i as 0 | 1 | 2;
    }
    const { pose, meta } = buffers();
    const res = packCrowdInputs(s.soa.views, pose, meta, {
      count: 3,
      capacity: CAP,
      variationCount: 1,
      scaleMin: 1,
      scaleMax: 1,
    });
    expect(res.liveCount).toBe(3);
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
