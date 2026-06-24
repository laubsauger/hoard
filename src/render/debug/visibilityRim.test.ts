// §V78 / T112 — the occluded visibility rim is the dev overlay's vision polygon. These guard that a clear
// cone reaches `range` on every ray, an occluder carves a shadow notch on EXACTLY the rays it blocks, the
// fan is oriented by heading±fovHalf, and the math is deterministic + scene-free.
import { describe, it, expect } from 'vitest';
import { occludedVisibilityRim } from './visibilityRim';

const distFromApex = (rim: Float32Array, i: number, ax = 0, az = 0): number =>
  Math.hypot(rim[i * 2]! - ax, rim[i * 2 + 1]! - az);

describe('occludedVisibilityRim (§V78)', () => {
  it('a clear cone puts every rim point at the full range', () => {
    const range = 10;
    const rim = occludedVisibilityRim(0, 0, 0, Math.PI / 2, range, 8, () => range);
    expect(rim.length).toBe(2 * (8 + 1));
    for (let i = 0; i < 9; i++) expect(distFromApex(rim, i)).toBeCloseTo(range, 6);
  });

  it('produces segments+1 rim points', () => {
    const rim = occludedVisibilityRim(0, 0, 0, 1, 5, 24, () => 5);
    expect(rim.length).toBe(2 * (24 + 1));
  });

  it('an occluder shortens EXACTLY the rays it blocks (a shadow notch)', () => {
    const range = 10;
    // Block any ray pointing within a narrow band around +x (angle ~0): a wall straight ahead at d=3.
    const wallAt = 3;
    const distanceAt = (a: number): number => (Math.abs(a) < 0.15 ? wallAt : range);
    const rim = occludedVisibilityRim(0, 0, 0, Math.PI / 2, range, 8, distanceAt);
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / 8;
      const expected = Math.abs(a) < 0.15 ? wallAt : range;
      expect(distFromApex(rim, i)).toBeCloseTo(expected, 6);
    }
    // The notch exists: at least one ray (dead-ahead, i=4 → a=0) is shortened, the edges are not.
    expect(distFromApex(rim, 4)).toBeCloseTo(wallAt, 6);
    expect(distFromApex(rim, 0)).toBeCloseTo(range, 6);
    expect(distFromApex(rim, 8)).toBeCloseTo(range, 6);
  });

  it('clamps a distanceAt that overshoots back to range', () => {
    const range = 6;
    const rim = occludedVisibilityRim(0, 0, 0, 1, range, 4, () => 999);
    for (let i = 0; i < 5; i++) expect(distFromApex(rim, i)).toBeCloseTo(range, 6);
  });

  it('orients the fan by heading±fovHalf (heading 0, fovHalf π/2 → first −z, mid +x, last +z)', () => {
    const range = 1;
    const rim = occludedVisibilityRim(0, 0, 0, Math.PI / 2, range, 2, () => range);
    // i=0 → angle −π/2 → (cos,sin)=(0,−1)
    expect(rim[0]).toBeCloseTo(0, 6);
    expect(rim[1]).toBeCloseTo(-1, 6);
    // i=1 → angle 0 → (1,0)
    expect(rim[2]).toBeCloseTo(1, 6);
    expect(rim[3]).toBeCloseTo(0, 6);
    // i=2 → angle +π/2 → (0,1)
    expect(rim[4]).toBeCloseTo(0, 6);
    expect(rim[5]).toBeCloseTo(1, 6);
  });

  it('respects a non-zero apex + heading (endpoints are apex + dir*dist)', () => {
    const range = 5;
    const ax = 12;
    const az = -7;
    const heading = Math.PI; // facing −x
    const rim = occludedVisibilityRim(ax, az, heading, 1e-6, range, 1, () => range);
    // Near-zero FOV → both rays ~along heading → endpoint ≈ apex + (cos π, sin π)*range = (ax−5, az)
    expect(rim[0]).toBeCloseTo(ax - range, 4);
    expect(rim[1]).toBeCloseTo(az, 4);
  });

  it('reuses the provided out buffer without allocating', () => {
    const out = new Float32Array(2 * (8 + 1));
    const rim = occludedVisibilityRim(0, 0, 0, 1, 5, 8, () => 5, out);
    expect(rim).toBe(out);
  });

  it('is deterministic (same inputs → identical output)', () => {
    const f = (a: number): number => (a < 0 ? 2 : 7);
    const a = occludedVisibilityRim(1, 2, 0.5, 1.1, 9, 16, f);
    const b = occludedVisibilityRim(1, 2, 0.5, 1.1, 9, 16, f);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
