// T72 / V2 / V3 / V13 / V17 — pure block-limbed crowd core: tier selection, pool cap, sever-hide,
// and per-instance transform composition. No GPU/three; runs on plain typed arrays + the frozen SoA.

import { describe, it, expect } from 'vitest';
import { allocateSoa, ZOMBIE_FIELDS } from '../../game/core/contracts/soa';
import { regionBit } from '../../game/combat/anatomy';
import {
  packLimbInputs,
  composeLimbMatrix,
  walkSwing,
  walkBob,
  FLOATS_PER_LIMB_POSE,
  FLOATS_PER_MAT4,
  type LimbPartPlacement,
} from './limbs';

const CAP = 8;

function makeSoa() {
  const soa = allocateSoa(ZOMBIE_FIELDS, CAP);
  return {
    soa,
    alive: soa.views['alive'] as Uint8Array,
    position: soa.views['position'] as Float32Array,
    heading: soa.views['heading'] as Float32Array,
    simTier: soa.views['simTier'] as Uint8Array,
    anatomyFlags: soa.views['anatomyFlags'] as Uint32Array,
    animPhase: soa.views['animPhase'] as Float32Array,
  };
}

function out(cap: number) {
  return {
    pose: new Float32Array(cap * FLOATS_PER_LIMB_POSE),
    scale: new Float32Array(cap),
    anatomy: new Uint32Array(cap),
    phase: new Float32Array(cap),
  };
}

const OPTS = { variationCount: 1, scaleMin: 1, scaleMax: 1, maxSimTier: 1 } as const;

describe('packLimbInputs — tier selection (V13)', () => {
  it('promotes only hero/active tiers (simTier <= maxSimTier); horde/abstract are skipped', () => {
    const s = makeSoa();
    // slot 0 hero, 1 active -> limbed; slot 2 horde, 3 abstract -> NOT limbed (box draws those).
    for (let i = 0; i < 4; i++) {
      s.alive[i] = 1;
      s.simTier[i] = i as 0 | 1 | 2 | 3;
      s.position[i * 3] = i; // x = slot for identity check
    }
    const o = out(CAP);
    const res = packLimbInputs(s.soa.views, o.pose, o.scale, o.anatomy, o.phase, { count: 4, capacity: CAP, ...OPTS });
    expect(res.liveCount).toBe(2);
    // Compacted to the front: instance 0 = slot 0 (x=0), instance 1 = slot 1 (x=1).
    expect(o.pose[0]).toBeCloseTo(0, 6);
    expect(o.pose[FLOATS_PER_LIMB_POSE]).toBeCloseTo(1, 6);
  });

  it('skips dead slots even within the limbed tier band', () => {
    const s = makeSoa();
    s.alive[0] = 0; // dead hero
    s.alive[1] = 1;
    s.simTier[1] = 1;
    const o = out(CAP);
    const res = packLimbInputs(s.soa.views, o.pose, o.scale, o.anatomy, o.phase, { count: 2, capacity: CAP, ...OPTS });
    expect(res.liveCount).toBe(1);
  });

  it('caps at the limbed budget (pool cap, no throw)', () => {
    const s = makeSoa();
    for (let i = 0; i < CAP; i++) {
      s.alive[i] = 1;
      s.simTier[i] = 0;
    }
    const budget = 3;
    const o = out(budget);
    const res = packLimbInputs(s.soa.views, o.pose, o.scale, o.anatomy, o.phase, { count: CAP, capacity: budget, ...OPTS });
    expect(res.liveCount).toBe(budget);
  });

  it('passes anatomyFlags and animPhase through per instance', () => {
    const s = makeSoa();
    s.alive[0] = 1;
    s.simTier[0] = 0;
    const flags = regionBit('armLeft') | regionBit('legRight');
    s.anatomyFlags[0] = flags;
    s.animPhase[0] = 0.42;
    const o = out(CAP);
    packLimbInputs(s.soa.views, o.pose, o.scale, o.anatomy, o.phase, { count: 1, capacity: CAP, ...OPTS });
    expect(o.anatomy[0]).toBe(flags);
    expect(o.phase[0]).toBeCloseTo(0.42, 6);
  });

  it('vision-cone cull hides figures outside the wedge (T98)', () => {
    const s = makeSoa();
    // slot 0 ahead (visible), slot 1 behind (hidden by the cone).
    s.alive[0] = 1; s.simTier[0] = 0; s.position[0] = 5; s.position[2] = 0;
    s.alive[1] = 1; s.simTier[1] = 0; s.position[1 * 3] = -5; s.position[1 * 3 + 2] = 0;
    const o = out(CAP);
    const res = packLimbInputs(s.soa.views, o.pose, o.scale, o.anatomy, o.phase, {
      count: 2,
      capacity: CAP,
      ...OPTS,
      visibility: { px: 0, pz: 0, heading: 0, fovHalf: Math.PI / 4, range: 20, edgeBandMeters: 0, edgeBandRadians: 0 },
    });
    expect(res.liveCount).toBe(1);
    expect(o.pose[0]).toBeCloseTo(5, 6);
  });

  it('over-budget figures fall through (continue, not break) so later slots still rank correctly', () => {
    // 3 limbed-eligible slots, budget 2: the first 2 become figures; the 3rd is left for the box path. The
    // ranking must keep counting past the cap (continue), matching packCrowdInputs' figureRank.
    const s = makeSoa();
    for (let i = 0; i < 3; i++) { s.alive[i] = 1; s.simTier[i] = 0; s.position[i * 3] = i; }
    const o = out(2);
    const res = packLimbInputs(s.soa.views, o.pose, o.scale, o.anatomy, o.phase, { count: 3, capacity: 2, ...OPTS });
    expect(res.liveCount).toBe(2);
    expect(o.pose[0]).toBeCloseTo(0, 6);
    expect(o.pose[FLOATS_PER_LIMB_POSE]).toBeCloseTo(1, 6);
  });
});

describe('composeLimbMatrix — transform composition (V2)', () => {
  const torso: LimbPartPlacement = { offset: [0, 1.2, 0], swingSign: 0 };
  const armRight: LimbPartPlacement = { offset: [0.34, 1.2, 0], swingSign: 1 };

  it('composes translation from position + part offset (heading 0)', () => {
    const m = new Float32Array(FLOATS_PER_MAT4);
    composeLimbMatrix(m, 0, [3, 0, -7], 0, 1, torso, 0, 0, true);
    expect(m[12]).toBeCloseTo(3, 6);
    expect(m[13]).toBeCloseTo(1.2, 6); // py + offset.y
    expect(m[14]).toBeCloseTo(-7, 6);
    expect(m[15]).toBeCloseTo(1, 6);
    // No rotation/swing: column 0 is the unscaled X axis.
    expect(m[0]).toBeCloseTo(1, 6);
    expect(m[2]).toBeCloseTo(0, 6);
  });

  it('rotates the part offset by heading (yaw)', () => {
    const m = new Float32Array(FLOATS_PER_MAT4);
    // heading = +90deg (moving +Z): the figure FACES +Z (forward +X → +Z), so a +X lateral offset swings to +Z.
    composeLimbMatrix(m, 0, [0, 0, 0], Math.PI / 2, 1, armRight, 0, 0, true);
    expect(m[12]).toBeCloseTo(0, 5); // x offset rotated away
    expect(m[14]).toBeCloseTo(0.34, 5); // now along +Z (faces the travel direction, not mirrored)
    // Column 0 (forward +X) = [cos, 0, +sin] = [0, 0, 1] → points along +Z (the travel direction).
    expect(m[0]).toBeCloseTo(0, 6);
    expect(m[2]).toBeCloseTo(1, 6);
  });

  it('applies uniform scale to the basis and offset', () => {
    const m = new Float32Array(FLOATS_PER_MAT4);
    composeLimbMatrix(m, 0, [0, 0, 0], 0, 2, torso, 0, 0, true);
    expect(m[0]).toBeCloseTo(2, 6); // scaled X axis
    expect(m[13]).toBeCloseTo(2.4, 6); // offset.y * scale
  });

  it('adds the vertical walk bob to y', () => {
    const m = new Float32Array(FLOATS_PER_MAT4);
    composeLimbMatrix(m, 0, [0, 0, 0], 0, 1, torso, 0, 0.1, true);
    expect(m[13]).toBeCloseTo(1.3, 6); // 1.2 + bob
  });

  it('zeroes the whole matrix when the part is severed (dismemberment hide, V17)', () => {
    const m = new Float32Array(FLOATS_PER_MAT4).fill(9);
    composeLimbMatrix(m, 0, [1, 2, 3], 0.5, 1, armRight, 0.4, 0.05, false);
    for (let i = 0; i < FLOATS_PER_MAT4; i++) expect(m[i]).toBe(0);
  });

  it('writes at the given base element offset', () => {
    const m = new Float32Array(FLOATS_PER_MAT4 * 2);
    composeLimbMatrix(m, FLOATS_PER_MAT4, [5, 0, 0], 0, 1, torso, 0, 0, true);
    expect(m[FLOATS_PER_MAT4 + 12]).toBeCloseTo(5, 6);
    expect(m[FLOATS_PER_MAT4 + 15]).toBeCloseTo(1, 6);
  });
});

describe('walk-cycle helpers', () => {
  it('swing is zero at phase 0 and bounded by amplitude', () => {
    expect(walkSwing(0, 0.5)).toBeCloseTo(0, 6);
    expect(Math.abs(walkSwing(0.25, 0.5))).toBeCloseTo(0.5, 6);
  });
  it('bob is non-negative (upward gait) and bounded', () => {
    expect(walkBob(0, 0.1)).toBeCloseTo(0, 6);
    expect(walkBob(0.25, 0.1)).toBeCloseTo(0.1, 6);
    expect(walkBob(0.5, 0.1)).toBeGreaterThanOrEqual(0);
  });
});
