// T136 — per-zombie corner-bias: some of the horde swings WIDE around a wall corner (goes around) while
// others cut the tight line, so they don't all funnel through the same diagonal shortcut past a house corner.
import { describe, it, expect } from 'vitest';
import { cornerBiasedWallWeight, combineSteer } from './steering';

describe('combineSteer flow/face decouple (T141 — anti-180°-flip)', () => {
  it('exposes the separation-FREE target direction even when neighbour repulsion reverses the move dir', () => {
    // Flow points +x (toward the goal). A neighbour pressed right ahead (+x, very close) repels hard backward.
    const r = combineSteer(1, 0, {
      x: 0,
      z: 0,
      neighbors: [{ dx: 0.1, dz: 0 }], // 0.1 m ahead → strong backward separation
      separation: 0.8,
      flowWeight: 0.3, // separation-dominant blend so the MOVE dir flips
    });
    // The MOVE direction is shoved backward (−x) by the crowd...
    expect(r.dirX).toBeLessThan(0);
    // ...but the FACING target stays locked on the goal (+x) — so a blocked, jostled body never flips its heading.
    expect(r.flowX).toBeCloseTo(1, 6);
    expect(r.flowZ).toBeCloseTo(0, 6);
  });

  it('reports a zero face direction when there is no flow (caller falls back / holds)', () => {
    const r = combineSteer(0, 0, { x: 0, z: 0, neighbors: [{ dx: 0.2, dz: 0 }], separation: 0.8, flowWeight: 0.85 });
    expect(r.flowX).toBe(0);
    expect(r.flowZ).toBe(0);
  });
});

describe('cornerBiasedWallWeight (T136)', () => {
  const BASE = 0.8;

  it('a 0 bias leaves the baseline wall-clearance weight unchanged (tight line)', () => {
    expect(cornerBiasedWallWeight(BASE, 0)).toBeCloseTo(BASE, 6);
  });

  it('a higher bias only ever WIDENS the berth — monotonic, never below the baseline', () => {
    const tight = cornerBiasedWallWeight(BASE, 0);
    const mid = cornerBiasedWallWeight(BASE, 0.5);
    const wide = cornerBiasedWallWeight(BASE, 1);
    expect(mid).toBeGreaterThan(tight);
    expect(wide).toBeGreaterThan(mid);
    expect(wide).toBeCloseTo(BASE * 2, 6); // max bias ≈ 2× berth
  });

  it('a negative bias is clamped to the baseline (a corner is never cut TIGHTER than T134 safe clearance)', () => {
    expect(cornerBiasedWallWeight(BASE, -1)).toBeCloseTo(BASE, 6);
  });

  it('zero baseline weight (clearance off / away from walls) stays zero regardless of bias', () => {
    expect(cornerBiasedWallWeight(0, 1)).toBe(0);
  });
});
