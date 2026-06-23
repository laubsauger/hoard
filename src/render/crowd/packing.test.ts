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

  it('writes per-instance meta [scale, seed, archetype, revealAlpha]', () => {
    const s = makeSoa();
    s.alive[0] = 1;
    s.archetype[0] = 4;

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
    expect(meta[3]).toBe(1); // V65: meta.w = reveal alpha; full (1) when no vision cull is supplied
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

  it('with limbedMaxSimTier set, the box packs ONLY the horde tiers (limbed tiers go to figures, T72)', () => {
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
      limbedMaxSimTier: 1, // tiers 0,1 are figures; the box draws 2,3 (budget large enough to claim 0,1)
    });
    expect(res.liveCount).toBe(2);
    // Compacted horde: instance 0 = slot 2 (x=2), instance 1 = slot 3 (x=3).
    expect(pose[0]).toBeCloseTo(2, 6);
    expect(pose[FLOATS_PER_POSE]).toBeCloseTo(3, 6);
  });

  it('§B culling fix: over-budget limbed-tier zombies FALL THROUGH to the box instead of vanishing', () => {
    // 4 NEAR zombies, all limbed-eligible (simTier 0). Limbed budget = 2 → the figure path renders the first 2;
    // WITHOUT the fix the other 2 matched neither path and disappeared (the "near zombies culled" bug). They
    // must now render as boxes here so the live set is fully covered: figures(2) + boxes(2) == alive(4).
    const s = makeSoa();
    for (let i = 0; i < 4; i++) {
      s.alive[i] = 1;
      s.simTier[i] = 0;
      s.position[i * 3] = i;
    }
    const { pose, meta } = buffers();
    const res = packCrowdInputs(s.soa.views, pose, meta, {
      count: 4,
      capacity: CAP,
      variationCount: 1,
      scaleMin: 1,
      scaleMax: 1,
      limbedMaxSimTier: 1,
      limbedBudget: 2,
    });
    // The box draws the 2 overflow figures (slots 2,3) — NOT zero (the pre-fix bug dropped them entirely).
    expect(res.liveCount).toBe(2);
    expect(pose[0]).toBeCloseTo(2, 6); // slot 2 fell through to the box
    expect(pose[FLOATS_PER_POSE]).toBeCloseTo(3, 6); // slot 3 fell through to the box
  });

  it('vision-cone cull: only members inside the cone + range are packed; outside ones are hidden', () => {
    const s = makeSoa();
    // slot 0 straight ahead (visible), slot 1 behind the player (hidden), slot 2 far beyond range (hidden).
    s.alive[0] = 1; s.position[0] = 5; s.position[2] = 0;
    s.alive[1] = 1; s.position[1 * 3] = -5; s.position[1 * 3 + 2] = 0;
    s.alive[2] = 1; s.position[2 * 3] = 50; s.position[2 * 3 + 2] = 0;
    const { pose, meta } = buffers();
    const res = packCrowdInputs(s.soa.views, pose, meta, {
      count: 3,
      capacity: CAP,
      variationCount: 1,
      scaleMin: 1,
      scaleMax: 1,
      visibility: {
        px: 0, pz: 0, heading: 0, // facing +x
        fovHalf: Math.PI / 4, range: 20,
        edgeBandMeters: 0, edgeBandRadians: 0,
      },
    });
    expect(res.liveCount).toBe(1); // only the forward, in-range zombie
    expect(pose[0]).toBeCloseTo(5, 6);
  });

  it('vision-cone cull: a soft edge band fades the packed ALPHA toward zero near the boundary (scale stays full)', () => {
    const s = makeSoa();
    s.alive[0] = 1; s.position[0] = 19; s.position[2] = 0; // just inside a 20m range with a 4m fade band
    const { pose, meta } = buffers();
    packCrowdInputs(s.soa.views, pose, meta, {
      count: 1, capacity: CAP, variationCount: 1, scaleMin: 1, scaleMax: 1,
      visibility: { px: 0, pz: 0, heading: 0, fovHalf: Math.PI / 2, range: 20, edgeBandMeters: 4, edgeBandRadians: 0 },
    });
    // (20 - 19) / 4 = 0.25 → V65: the fade lands on the per-instance reveal ALPHA in meta.w, NOT the scale.
    expect(meta[3]).toBeCloseTo(0.25, 5);
    expect(meta[0]).toBeCloseTo(1, 6); // scale stays full — members blend via alpha, they don't shrink
  });

  it('without limbedMaxSimTier the box packs all live slots (default, unchanged)', () => {
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
