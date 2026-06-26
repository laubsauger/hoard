// T140 / V2 / V3 — the crowd's ONE shared LOD partition is now by DISTANCE (rigged near / impostor far), with NO
// box path and NO count budget. These tests cover the band assignment + the §B "exactly one lane" guarantee.

import { describe, it, expect } from 'vitest';
import { allocateSoa, ZOMBIE_FIELDS } from '../../game/core/contracts/soa';
import {
  computeDistanceBand,
  BAND_RIGGED,
  BAND_IMPOSTOR,
  variationSeed,
  variationScale,
  variationHash01,
  variationTint,
} from './packing';

const CAP = 8;

function makeSoa() {
  const soa = allocateSoa(ZOMBIE_FIELDS, CAP);
  return {
    soa,
    alive: soa.views['alive'] as Uint8Array,
    position: soa.views['position'] as Float32Array,
    simTier: soa.views['simTier'] as Uint8Array,
  };
}

describe('computeDistanceBand — rigged (near) vs impostor (far) LOD by distance', () => {
  // n alive zombies along +x at distances 1,2,3,… from the origin anchor.
  const lineSoa = (n: number) => {
    const s = makeSoa();
    for (let i = 0; i < n; i++) {
      s.alive[i] = 1;
      s.position[i * 3] = i + 1; // x = 1,2,3,…
    }
    return s;
  };

  it('marks zombies within the rigged distance as BAND_RIGGED, farther ones as BAND_IMPOSTOR', () => {
    const s = lineSoa(5); // at x = 1..5
    const mask = computeDistanceBand(s.soa.views, 5, 0, 0, /*riggedMaxDist*/ 3.5);
    // distances 1,2,3 within 3.5 → rigged; 4,5 → impostor.
    expect(Array.from(mask.subarray(0, 5))).toEqual([BAND_RIGGED, BAND_RIGGED, BAND_RIGGED, BAND_IMPOSTOR, BAND_IMPOSTOR]);
  });

  it('is measured from the ANCHOR, not slot order — a far low slot is impostor, a near high slot is rigged', () => {
    const s = makeSoa();
    s.alive[0] = 1; s.position[0] = 100; // far
    s.alive[1] = 1; s.position[3] = 1; // near
    const mask = computeDistanceBand(s.soa.views, 2, 0, 0, 10);
    expect(Array.from(mask.subarray(0, 2))).toEqual([BAND_IMPOSTOR, BAND_RIGGED]);
  });

  it('uses the actual anchor position (player/camera XZ)', () => {
    const s = makeSoa();
    s.alive[0] = 1; s.position[0] = 50; s.position[2] = 50;
    // anchor right next to it → rigged.
    const mask = computeDistanceBand(s.soa.views, 1, 49, 49, 5);
    expect(mask[0]).toBe(BAND_RIGGED);
  });

  it('riggedMaxDist <= 0 → everything is an impostor', () => {
    const s = lineSoa(3);
    const mask = computeDistanceBand(s.soa.views, 3, 0, 0, 0);
    expect(Array.from(mask.subarray(0, 3))).toEqual([BAND_IMPOSTOR, BAND_IMPOSTOR, BAND_IMPOSTOR]);
  });

  it('reuses a scratch buffer when one is supplied (allocation-free hot path)', () => {
    const s = lineSoa(4);
    const scratch = new Uint8Array(CAP);
    const out = computeDistanceBand(s.soa.views, 4, 0, 0, 2.5, scratch);
    expect(out).toBe(scratch);
  });

  it('§B — every ALIVE zombie is claimed by EXACTLY ONE lane (rigged XOR impostor); no box, none vanish', () => {
    const s = makeSoa();
    // 6 alive at a spread of distances straddling the cutoff, plus dead slots interleaved.
    const xs = [1, 5, 12, 30, 70, 200];
    for (let i = 0; i < xs.length; i++) {
      s.alive[i] = 1;
      s.position[i * 3] = xs[i]!;
      s.simTier[i] = (i % 4) as 0 | 1 | 2 | 3; // tier no longer affects the partition
    }
    s.alive[6] = 0; // dead
    const mask = computeDistanceBand(s.soa.views, 7, 0, 0, /*riggedMaxDist*/ 40);
    let rigged = 0;
    let impostor = 0;
    for (let i = 0; i < 6; i++) {
      // each alive slot is exactly one band byte (0 or 1) — there is no third "box" state.
      expect(mask[i] === BAND_RIGGED || mask[i] === BAND_IMPOSTOR).toBe(true);
      if (mask[i] === BAND_RIGGED) rigged++; else impostor++;
    }
    expect(rigged + impostor).toBe(6); // all six alive covered, exactly once
    expect(rigged).toBe(4); // x = 1,5,12,30 within 40
    expect(impostor).toBe(2); // x = 70,200 beyond 40
  });

  // REGRESSION (invisible-enemy bug): the SoA is a SPARSE free-list — an alive zombie can sit at a slot index
  // >= the alive POPULATION. The render scan extent MUST be the slot capacity, never the alive count, or such a
  // zombie is never drawn while it is still simulated + attacking.
  it('scans the full SLOT EXTENT so a high-index alive zombie (slot >= alive-count) is still banded', () => {
    const s = makeSoa();
    s.alive[5] = 1; // a SINGLE alive zombie at slot 5 — alive population is 1, but its slot index is 5
    s.position[5 * 3] = 1; // x = 1 (within rigged distance of the anchor)

    // CORRECT: scanning the full slot extent (capacity) finds + bands it.
    const full = computeDistanceBand(s.soa.views, CAP, 0, 0, /*riggedMaxDist*/ 3.5);
    expect(full[5]).toBe(BAND_RIGGED);

    // BUG REPRO: scanning only the alive population (1) bounds the loop + mask to [0,1) → slot 5 is not even in
    // the output mask (undefined), so the lanes never draw it — invisible despite being alive + attacking.
    const buggy = computeDistanceBand(s.soa.views, 1, 0, 0, 3.5);
    expect(buggy[5]).toBeUndefined();
  });
});

describe('variationSeed / variationScale stability (V26)', () => {
  it('variationSeed is deterministic and bounded', () => {
    for (let i = 0; i < 100; i++) {
      const v = variationSeed(i, 16);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(16);
      expect(v).toBe(variationSeed(i, 16));
    }
  });

  it('variationScale spans the band ends across the seed range', () => {
    expect(variationScale(0, 16, 0.9, 1.1)).toBeCloseTo(0.9, 6);
    expect(variationScale(15, 16, 0.9, 1.1)).toBeCloseTo(1.1, 6);
  });
});

describe('variationHash01 (T122/V87)', () => {
  it('is deterministic + bounded in [0,1)', () => {
    for (let i = 0; i < 200; i++) {
      const v = variationHash01(i, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(v).toBe(variationHash01(i, 7));
    }
  });

  it('decorrelates channels by salt', () => {
    let differ = 0;
    for (let i = 0; i < 64; i++) {
      if (Math.abs(variationHash01(i, 0x1111) - variationHash01(i, 0x2222)) > 1e-6) differ++;
    }
    expect(differ).toBe(64);
  });
});

describe('variationTint (T122/V87)', () => {
  it('no jitter → base colour, clamped to [0,1]', () => {
    const out = new Float32Array(3);
    variationTint(0.4, 0.5, 0.6, 0, 0, 0.1, 0.15, out, 0);
    expect(out[0]).toBeCloseTo(0.4, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[2]).toBeCloseTo(0.6, 6);
  });

  it('hue jitter skews R and B oppositely; value jitter scales brightness', () => {
    const warm = new Float32Array(3);
    variationTint(0.5, 0.5, 0.5, 1, 0, 0.2, 0, warm, 0);
    expect(warm[0]).toBeGreaterThan(0.5);
    expect(warm[2]).toBeLessThan(0.5);
    const dark = new Float32Array(3);
    variationTint(0.5, 0.5, 0.5, 0, -1, 0, 0.3, dark, 0);
    expect(dark[0]).toBeLessThan(0.5);
  });

  it('clamps each channel into [0,1]', () => {
    const out = new Float32Array(3);
    variationTint(0.95, 0.95, 0.95, 1, 1, 0.5, 0.5, out, 0);
    for (const ch of out) {
      expect(ch).toBeGreaterThanOrEqual(0);
      expect(ch).toBeLessThanOrEqual(1);
    }
  });
});
