// T125 — time-of-day VIEW + dev-override store. Primitive fields, range-validated, no per-frame coupling.

import { describe, it, expect } from 'vitest';
import { createTimeOfDayStore } from './timeOfDay';

describe('timeOfDayStore (T125)', () => {
  it('starts not-overridden and accepts engine-pushed current time', () => {
    const s = createTimeOfDayStore();
    expect(s.getState().overrideEnabled).toBe(false);
    s.getState().setCurrent(0.42);
    expect(s.getState().current).toBe(0.42);
  });

  it('scrubs + freezes an override that the lighting can read', () => {
    const s = createTimeOfDayStore();
    s.getState().setOverride(0.75);
    s.getState().setOverrideEnabled(true);
    expect(s.getState().overrideEnabled).toBe(true);
    expect(s.getState().override).toBe(0.75);
  });

  it('rejects out-of-range fractions (no silent clamp, V4)', () => {
    const s = createTimeOfDayStore();
    expect(() => s.getState().setCurrent(1.5)).toThrow();
    expect(() => s.getState().setCurrent(-0.1)).toThrow();
    expect(() => s.getState().setOverride(2)).toThrow();
    expect(() => s.getState().setCurrent(Number.NaN)).toThrow();
  });

  it('only exposes primitive fields (B24 — selectors never need object literals)', () => {
    const s = createTimeOfDayStore().getState();
    expect(typeof s.current).toBe('number');
    expect(typeof s.override).toBe('number');
    expect(typeof s.overrideEnabled).toBe('boolean');
  });
});
