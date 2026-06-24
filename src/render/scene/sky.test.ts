// T38 — pure day/night sky math: the directional key light follows the clock's day fraction and weather
// dims the scene. No GPU, so this is a plain logic assertion (V12/V4).

import { describe, it, expect } from 'vitest';
import { resolveDomain } from '../../config/registry';
import { lightingConfig } from '../../config/domains/lighting';
import { weatherConfig } from '../../config/domains/weather';
import { computeSkyState, dayPhaseOf, formatTimeOfDay } from './sky';

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

describe('day phase + clock readout (T125)', () => {
  it('labels noon as Day, midnight as Night, and the horizon crossings as Dawn/Dusk', () => {
    expect(dayPhaseOf(0.5)).toBe('day'); // noon
    expect(dayPhaseOf(0.0)).toBe('night'); // midnight
    expect(dayPhaseOf(0.25)).toBe('dawn'); // sunrise (horizon)
    expect(dayPhaseOf(0.75)).toBe('dusk'); // sunset (horizon)
  });

  it('agrees with computeSkyState about whether it is day', () => {
    for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const phase = dayPhaseOf(t);
      const isDay = computeSkyState(t, L, W, 0).isDay;
      // 'day'/'dawn'(rising before noon, still above? no) — the only hard guarantee: a 'day' label ⇒ sun up,
      // a 'night' label ⇒ sun down. Twilight straddles the horizon so it is not asserted against isDay.
      if (phase === 'day') expect(isDay).toBe(true);
      if (phase === 'night') expect(isDay).toBe(false);
    }
  });

  it('formats the day fraction as a 24h HH:MM clock', () => {
    expect(formatTimeOfDay(0)).toBe('00:00');
    expect(formatTimeOfDay(0.5)).toBe('12:00');
    expect(formatTimeOfDay(0.25)).toBe('06:00');
    expect(formatTimeOfDay(0.75)).toBe('18:00');
    // padded minutes
    expect(formatTimeOfDay(1 / 24 + 5 / 1440)).toBe('01:05');
  });

  it('rejects out-of-range fractions (V4)', () => {
    expect(() => dayPhaseOf(-0.1)).toThrow();
    expect(() => formatTimeOfDay(1.2)).toThrow();
  });
});
