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
});
