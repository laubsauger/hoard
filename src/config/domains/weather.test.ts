// T38 — weather config domain: self-registers + validates (V4); severity mapping is total + ordered.

import { describe, it, expect } from 'vitest';
import { validateAll, registeredDomains, resolveDomain } from '../registry';
import { weatherConfig, weatherSeverity, WEATHER_PROFILES } from './weather';

describe('weather config domain (V4)', () => {
  it('registers and passes validateAll', () => {
    expect(registeredDomains()).toContain('weather');
    expect(() => validateAll()).not.toThrow();
  });

  it('resolves a sane day/night geometry', () => {
    const w = resolveDomain(weatherConfig, 'desktop-high');
    expect(w.dayLengthSeconds).toBeGreaterThan(0);
    expect(w.startTimeOfDay).toBeGreaterThanOrEqual(0);
    expect(w.startTimeOfDay).toBeLessThanOrEqual(1);
    expect(w.sunElevationMaxDegrees).toBeGreaterThan(0);
    expect(w.sunElevationMaxDegrees).toBeLessThanOrEqual(90);
  });

  it('maps every profile to a severity, clear being the calmest', () => {
    const w = resolveDomain(weatherConfig, 'desktop-high');
    for (const p of WEATHER_PROFILES) {
      const s = weatherSeverity(w, p);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect(weatherSeverity(w, 'clear')).toBeLessThan(weatherSeverity(w, 'fog'));
    expect(weatherSeverity(w, 'clear')).toBeLessThan(weatherSeverity(w, 'rain'));
  });
});
