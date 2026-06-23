// Weather precipitation — pure RainField logic (no GPU). Covers the four invariants the WeatherView relies on:
//   - a drop recycles to the TOP once it falls past the ground (fixed pool always covers the view),
//   - intensity ramps smoothly toward the active profile target and is 0 in clear (gated),
//   - the pool is hard-capped (never grows),
//   - the wind slant drifts a drop horizontally by windSlant * fallDistance.

import { describe, it, expect } from 'vitest';
import { RainField, resolveRainSettings, rainTargetFor } from './weatherView';

const settings = resolveRainSettings('desktop-high');

describe('RainField — recycle to top (V24 pooled curtain)', () => {
  it('recycles a drop to near the top once it passes the ground', () => {
    const f = new RainField(settings);
    const groundY = settings.groundYMeters;
    const top = groundY + settings.fallHeightMeters;
    f.y[0] = groundY + 0.05; // a hair above the ground
    const dt = 0.016;
    const fall = settings.speedMps * dt;
    expect(fall).toBeGreaterThan(0.05); // sanity: this dt crosses the ground
    f.update(dt, 1, 0, 0);
    // Recycled: back near the top of the column (continuous, minus the sub-cell overshoot), never below ground.
    expect(f.y[0]!).toBeGreaterThan(groundY + settings.fallHeightMeters - fall);
    expect(f.y[0]!).toBeLessThanOrEqual(top);
    expect(f.y[0]!).toBeGreaterThan(groundY);
  });

  it('a drop well above the ground just falls (does not recycle)', () => {
    const f = new RainField(settings);
    const startY = settings.groundYMeters + settings.fallHeightMeters; // top
    f.y[0] = startY;
    const dt = 0.016;
    f.update(dt, 1, 0, 0);
    expect(f.y[0]!).toBeCloseTo(startY - settings.speedMps * dt, 5);
  });
});

describe('RainField — intensity ramp (no pop)', () => {
  it('ramps up toward the target at the configured rate', () => {
    const f = new RainField(settings);
    expect(f.intensity).toBe(0);
    const dt = 0.1;
    f.update(dt, 1, 0, 0);
    expect(f.intensity).toBeCloseTo(settings.rampPerSecond * dt, 6);
    // Eventually saturates at the target and never overshoots.
    for (let i = 0; i < 100; i++) f.update(dt, 1, 0, 0);
    expect(f.intensity).toBe(1);
  });

  it('ramps down toward a lower target without snapping', () => {
    const f = new RainField(settings);
    for (let i = 0; i < 100; i++) f.update(0.1, 1, 0, 0); // saturate to 1
    f.update(0.1, 0, 0, 0); // clear target
    expect(f.intensity).toBeLessThan(1);
    expect(f.intensity).toBeCloseTo(1 - settings.rampPerSecond * 0.1, 6);
  });

  it('is gated to 0 in the clear profile and stays hidden', () => {
    expect(rainTargetFor('clear', settings)).toBe(0);
    const f = new RainField(settings);
    f.update(0.5, rainTargetFor('clear', settings), 0, 0);
    expect(f.intensity).toBe(0);
    expect(f.visibleCount).toBe(0);
  });

  it('per-profile targets: rain full, smoke a lighter drizzle, fog none', () => {
    expect(rainTargetFor('rain', settings)).toBe(1);
    expect(rainTargetFor('fog', settings)).toBe(0);
    expect(rainTargetFor('smoke', settings)).toBeGreaterThan(0);
    expect(rainTargetFor('smoke', settings)).toBeLessThan(1);
  });
});

describe('RainField — pool cap (V24)', () => {
  it('never exceeds the configured pool size', () => {
    const f = new RainField(settings);
    expect(f.poolSize).toBe(settings.poolSize);
    expect(f.ox.length).toBe(settings.poolSize);
    expect(f.oz.length).toBe(settings.poolSize);
    expect(f.y.length).toBe(settings.poolSize);
    // At full intensity the whole pool is visible but the count is clamped to the cap.
    for (let i = 0; i < 100; i++) f.update(0.1, 1, 0, 0);
    expect(f.visibleCount).toBe(settings.poolSize);
    expect(f.visibleCount).toBeLessThanOrEqual(f.poolSize);
  });
});

describe('RainField — wind slant', () => {
  it('drifts a (non-recycling) drop horizontally by windSlant * fallDistance', () => {
    const f = new RainField(settings);
    f.ox[0] = 0;
    f.y[0] = settings.groundYMeters + settings.fallHeightMeters; // top → will not recycle this step
    const dt = 0.016;
    f.update(dt, 1, 0, 0);
    const expectedDrift = settings.windSlant * settings.speedMps * dt;
    expect(f.ox[0]!).toBeCloseTo(expectedDrift, 6);
  });

  it('rejects negative dt and out-of-range targets', () => {
    const f = new RainField(settings);
    expect(() => f.update(-0.1, 1, 0, 0)).toThrow();
    expect(() => f.update(0.1, 1.5, 0, 0)).toThrow();
  });
});
