// T136 — per-zombie corner-bias: some of the horde swings WIDE around a wall corner (goes around) while
// others cut the tight line, so they don't all funnel through the same diagonal shortcut past a house corner.
import { describe, it, expect } from 'vitest';
import { cornerBiasedWallWeight } from './steering';

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
