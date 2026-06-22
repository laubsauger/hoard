// T38 — pure day/night sky math: the directional key light follows the clock's day fraction and weather
// dims the scene. No GPU, so this is a plain logic assertion (V12/V4).

import { describe, it, expect } from 'vitest';
import { resolveDomain } from '../../config/registry';
import { lightingConfig } from '../../config/domains/lighting';
import { weatherConfig } from '../../config/domains/weather';
import { computeSkyState } from './sky';

const L = resolveDomain(lightingConfig, 'desktop-high');
const W = resolveDomain(weatherConfig, 'desktop-high');

describe('computeSkyState (T38 day/night)', () => {
  it('is bright daylight at noon with the key light pointing down', () => {
    const s = computeSkyState(0.5, L, W, 0);
    expect(s.isDay).toBe(true);
    expect(s.elevation01).toBeGreaterThan(0.9);
    expect(s.direction.y).toBeLessThan(0); // light travels downward from a high sun
    expect(s.keyIntensity).toBeGreaterThan(L.moonIntensity);
    expect(s.keyIntensity).toBeCloseTo(L.sunIntensity, 1);
  });

  it('falls to moonlight at midnight', () => {
    const s = computeSkyState(0, L, W, 0);
    expect(s.isDay).toBe(false);
    expect(s.keyIntensity).toBeCloseTo(L.moonIntensity, 2);
  });

  it('darkens the ambient fill as weather severity rises', () => {
    const clear = computeSkyState(0.5, L, W, 0);
    const heavy = computeSkyState(0.5, L, W, 1);
    expect(heavy.ambientIntensity).toBeLessThan(clear.ambientIntensity);
    expect(heavy.keyIntensity).toBeLessThan(clear.keyIntensity);
  });

  it('rejects out-of-range inputs (no silent clamp, V4)', () => {
    expect(() => computeSkyState(1.5, L, W, 0)).toThrow();
    expect(() => computeSkyState(0.5, L, W, -0.1)).toThrow();
  });
});
