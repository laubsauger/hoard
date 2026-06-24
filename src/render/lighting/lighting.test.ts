// T29 / V8 / V22 — shadow-caster priority ordering, cascade splits, light budget, fog/exposure.

import { describe, it, expect } from 'vitest';
import {
  computeCascadeSplits,
  casterScore,
  prioritizeCasters,
  resolveCasterPriorityWeights,
  resolveCascadeSettings,
  selectActiveLights,
  resolveLocalLightBudget,
  fogTransmittance,
  interiorExposure,
  interiorExposureCompensation,
  resolveFogDistances,
  approach,
  resolveToneExposure,
  type ShadowCaster,
} from './lighting';

const weights = resolveCasterPriorityWeights('desktop-high');
const maxDist = resolveCascadeSettings('desktop-high').maxDistanceMeters;

const caster = (id: number, over: Partial<ShadowCaster> = {}): ShadowCaster => ({
  id, screenContribution: 0, distanceMeters: 10, tierImportance: 0, threat: 0, ...over,
});

describe('shadow-caster prioritization (T29/V22 #2)', () => {
  it('ranks higher screen contribution / threat / proximity / tier first', () => {
    const casters = [
      caster(1, { screenContribution: 0.1, distanceMeters: 100 }),
      caster(2, { screenContribution: 0.9, distanceMeters: 5, threat: 1, tierImportance: 1 }),
      caster(3, { screenContribution: 0.5, distanceMeters: 30 }),
    ];
    const order = prioritizeCasters(casters, 3, weights, maxDist);
    expect(order[0]).toBe(2); // clearly most important
    expect(order.indexOf(3)).toBeLessThan(order.indexOf(1));
  });

  it('enforces the caster budget (secondary casters dropped first)', () => {
    const casters = Array.from({ length: 10 }, (_, i) => caster(i, { screenContribution: i / 10 }));
    const chosen = prioritizeCasters(casters, 3, weights, maxDist);
    expect(chosen).toHaveLength(3);
    // highest screenContribution ids (9,8,7) win.
    expect(chosen).toContain(9);
    expect(chosen).not.toContain(0);
  });

  it('drops casters beyond the max shadow distance regardless of score', () => {
    const casters = [caster(1, { screenContribution: 1, distanceMeters: maxDist + 50 })];
    expect(prioritizeCasters(casters, 4, weights, maxDist)).toHaveLength(0);
  });

  it('casterScore rewards proximity (nearer scores higher, all else equal)', () => {
    const near = casterScore(caster(1, { distanceMeters: 1 }), weights, maxDist);
    const far = casterScore(caster(2, { distanceMeters: maxDist - 1 }), weights, maxDist);
    expect(near).toBeGreaterThan(far);
  });

  it('is stable by id on ties', () => {
    const casters = [caster(5), caster(2), caster(8)];
    expect(prioritizeCasters(casters, 3, weights, maxDist)).toEqual([2, 5, 8]);
  });
});

describe('cascade splits (T29)', () => {
  it('produces `count` ascending splits ending at far', () => {
    const splits = computeCascadeSplits(1, 200, 4, 0.6);
    expect(splits).toHaveLength(4);
    for (let i = 1; i < splits.length; i++) expect(splits[i]!).toBeGreaterThan(splits[i - 1]!);
    expect(splits[splits.length - 1]).toBeCloseTo(200, 5);
  });

  it('rejects invalid ranges (V4)', () => {
    expect(() => computeCascadeSplits(0, 100, 3, 0.5)).toThrow();
    expect(() => computeCascadeSplits(10, 5, 3, 0.5)).toThrow();
    expect(() => computeCascadeSplits(1, 100, 3, 2)).toThrow();
  });
});

describe('dynamic local lights (V22 #5)', () => {
  it('keeps the most important lights within budget', () => {
    const lights = [
      { id: 1, importance: 0.2 },
      { id: 2, importance: 0.9 },
      { id: 3, importance: 0.5 },
    ];
    expect(selectActiveLights(lights, 2)).toEqual([2, 3]);
  });

  it('resolves a positive per-tier budget that scales down on mobile', () => {
    expect(resolveLocalLightBudget('desktop-high')).toBeGreaterThan(resolveLocalLightBudget('mobile-webgpu'));
  });
});

describe('atmosphere (T29)', () => {
  it('fog transmittance decreases with distance and worsening weather', () => {
    const near = fogTransmittance(10, 0, 'desktop-high');
    const far = fogTransmittance(100, 0, 'desktop-high');
    expect(far).toBeLessThan(near);
    const heavy = fogTransmittance(100, 1, 'desktop-high');
    expect(heavy).toBeLessThan(far);
    expect(near).toBeLessThanOrEqual(1);
  });

  it('interior exposure rises smoothly from 0 to the configured stops', () => {
    expect(interiorExposure(0, 'desktop-high')).toBe(0);
    expect(interiorExposure(1, 'desktop-high')).toBeGreaterThan(0);
    expect(interiorExposure(0.5, 'desktop-high')).toBeLessThan(interiorExposure(1, 'desktop-high'));
    expect(() => interiorExposure(1.5, 'desktop-high')).toThrow();
  });

  it('B44: interior compensation FADES with daylight — full at night, gone at midday (default falloff=1)', () => {
    const fullyInside = 1;
    const nightBoost = interiorExposureCompensation(fullyInside, 0, 'desktop-high'); // full dark
    const dayBoost = interiorExposureCompensation(fullyInside, 1, 'desktop-high'); // full daylight
    expect(nightBoost).toBeCloseTo(interiorExposure(fullyInside, 'desktop-high'), 6); // == raw boost at night
    expect(dayBoost).toBe(0); // gone at midday → leaving a building won't darken the daylit exterior
    // monotonic: brighter scene ⇒ smaller interior boost.
    expect(interiorExposureCompensation(fullyInside, 0.25, 'desktop-high')).toBeGreaterThan(
      interiorExposureCompensation(fullyInside, 0.75, 'desktop-high'),
    );
    expect(() => interiorExposureCompensation(1, 1.5, 'desktop-high')).toThrow();
  });
});

describe('fog distances (B5 — analytic + clamped + smoothed)', () => {
  it('returns near as the configured fraction of far, far within the clamp band', () => {
    const clear = resolveFogDistances(0, 'desktop-high');
    expect(clear.far).toBeGreaterThan(clear.near);
    expect(clear.near).toBeCloseTo(clear.far * 0.35, 5); // fogNearRatio default
    expect(clear.far).toBeLessThanOrEqual(360); // fogFarMax default
    expect(clear.far).toBeGreaterThanOrEqual(60); // fogFarMin default
  });

  it('pulls the far plane nearer as weather severity rises (monotonic), still clamped', () => {
    const clear = resolveFogDistances(0, 'desktop-high').far;
    const mid = resolveFogDistances(0.5, 'desktop-high').far;
    const heavy = resolveFogDistances(1, 'desktop-high').far;
    expect(mid).toBeLessThanOrEqual(clear);
    expect(heavy).toBeLessThanOrEqual(mid);
    expect(heavy).toBeGreaterThanOrEqual(60); // never collapses below the floor
  });

  it('is continuous (no navCell-quantized banding) — tiny severity steps give tiny far steps', () => {
    const a = resolveFogDistances(0.30, 'desktop-high').far;
    const b = resolveFogDistances(0.31, 'desktop-high').far;
    expect(Math.abs(a - b)).toBeLessThan(5); // smooth, not a multi-meter jump
  });

  it('rejects out-of-range severity (V4)', () => {
    expect(() => resolveFogDistances(-0.1, 'desktop-high')).toThrow();
    expect(() => resolveFogDistances(1.1, 'desktop-high')).toThrow();
  });
});

describe('approach (B5 — frame-rate-independent smoothing)', () => {
  it('snaps to target when dt<=0 (construction-time prime)', () => {
    expect(approach(10, 100, 5, 0)).toBe(100);
    expect(approach(10, 100, 5, -1)).toBe(100);
  });

  it('moves toward the target but does not overshoot in one step', () => {
    const next = approach(0, 100, 4, 1 / 60);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(100);
  });

  it('converges toward the target over repeated steps', () => {
    let v = 0;
    for (let i = 0; i < 240; i++) v = approach(v, 100, 4, 1 / 60);
    expect(v).toBeCloseTo(100, 0);
  });

  it('rejects a negative rate (V4)', () => {
    expect(() => approach(0, 1, -1, 0.1)).toThrow();
  });
});

describe('tone-mapping exposure compensation (B6)', () => {
  const base = 1;
  const nightBoostStops = 1.5;

  it('equals the base exposure at full daylight, exterior (no compensation)', () => {
    expect(resolveToneExposure({ baseExposure: base, interiorStops: 0, sceneBrightness: 1, nightBoostStops })).toBeCloseTo(base, 6);
  });

  it('lifts exposure as the scene darkens (night floor), monotonically', () => {
    const day = resolveToneExposure({ baseExposure: base, interiorStops: 0, sceneBrightness: 1, nightBoostStops });
    const dusk = resolveToneExposure({ baseExposure: base, interiorStops: 0, sceneBrightness: 0.5, nightBoostStops });
    const night = resolveToneExposure({ baseExposure: base, interiorStops: 0, sceneBrightness: 0, nightBoostStops });
    expect(dusk).toBeGreaterThan(day);
    expect(night).toBeGreaterThan(dusk);
    // full dark adds exactly nightBoostStops -> 2^stops multiplier over base.
    expect(night).toBeCloseTo(base * Math.pow(2, nightBoostStops), 6);
  });

  it('adds interior stops multiplicatively on top of the night term', () => {
    const exterior = resolveToneExposure({ baseExposure: base, interiorStops: 0, sceneBrightness: 0.5, nightBoostStops });
    const interior = resolveToneExposure({ baseExposure: base, interiorStops: 1, sceneBrightness: 0.5, nightBoostStops });
    expect(interior).toBeCloseTo(exterior * 2, 6); // +1 stop = x2
  });

  it('rejects invalid inputs (V4)', () => {
    expect(() => resolveToneExposure({ baseExposure: 0, interiorStops: 0, sceneBrightness: 1, nightBoostStops })).toThrow();
    expect(() => resolveToneExposure({ baseExposure: base, interiorStops: -1, sceneBrightness: 1, nightBoostStops })).toThrow();
    expect(() => resolveToneExposure({ baseExposure: base, interiorStops: 0, sceneBrightness: 1.5, nightBoostStops })).toThrow();
    expect(() => resolveToneExposure({ baseExposure: base, interiorStops: 0, sceneBrightness: 1, nightBoostStops: -1 })).toThrow();
  });
});
