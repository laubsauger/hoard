// T109 / V72 — passive awareness radius scales with ambient light. Pure math: night floor → daylight ceiling,
// monotonic, clamped, and it REFUSES misconfiguration (NaN / inverted bounds) rather than silently fudging.

import { describe, it, expect } from 'vitest';
import { passiveRadiusFromAmbient, type PassiveAwarenessConfig } from './passiveAwareness';

const CFG: PassiveAwarenessConfig = { minRadiusMeters: 4, maxRadiusMeters: 14 };

describe('passiveRadiusFromAmbient (V72)', () => {
  it('full darkness (brightness 0) gives the night-floor MINIMUM radius', () => {
    expect(passiveRadiusFromAmbient(0, CFG)).toBe(4);
  });

  it('full daylight (brightness 1) gives the bright-midday MAXIMUM radius', () => {
    expect(passiveRadiusFromAmbient(1, CFG)).toBe(14);
  });

  it('half brightness lerps to the midpoint', () => {
    expect(passiveRadiusFromAmbient(0.5, CFG)).toBeCloseTo(9, 6);
  });

  it('grows monotonically with brightness (brighter day → larger passive radius)', () => {
    const a = passiveRadiusFromAmbient(0.2, CFG);
    const b = passiveRadiusFromAmbient(0.6, CFG);
    const c = passiveRadiusFromAmbient(0.9, CFG);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it('clamps an out-of-range brightness to the bounds (no extrapolation past min/max)', () => {
    expect(passiveRadiusFromAmbient(-0.5, CFG)).toBe(4); // below 0 → min
    expect(passiveRadiusFromAmbient(2, CFG)).toBe(14); // above 1 → max
  });

  it('a degenerate min==max config always returns that radius', () => {
    expect(passiveRadiusFromAmbient(0.3, { minRadiusMeters: 6, maxRadiusMeters: 6 })).toBe(6);
  });

  it('throws on a non-finite brightness (a bug, not something to paper over)', () => {
    expect(() => passiveRadiusFromAmbient(NaN, CFG)).toThrow();
    expect(() => passiveRadiusFromAmbient(Infinity, CFG)).toThrow();
  });

  it('throws on an inverted (max < min) config', () => {
    expect(() => passiveRadiusFromAmbient(0.5, { minRadiusMeters: 14, maxRadiusMeters: 4 })).toThrow();
  });
});
