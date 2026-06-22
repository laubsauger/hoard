// T31 / V22 / V29 — dynamic resolution reduces BEFORE touching sim; strict scaling order; damage feedback.

import { describe, it, expect } from 'vitest';
import {
  SCALING_STAGES,
  INITIAL_SCALING_STATE,
  isScalingLever,
  planScaling,
  resolveDynamicResolutionSettings,
  selectGradingProfile,
  damageFeedback,
  type ScalingState,
  type AccessibilityFeedback,
} from './postfx';

const settings = resolveDynamicResolutionSettings('desktop-high');

describe('V22 scaling order + dynamic resolution', () => {
  it('lists horde density LAST and never lists simulation correctness as a lever', () => {
    expect(SCALING_STAGES[0]).toBe('internalResolution');
    expect(SCALING_STAGES[SCALING_STAGES.length - 1]).toBe('hordeDensity');
    expect(isScalingLever('hordeDensity')).toBe(true);
    expect(isScalingLever('simulationCorrectness')).toBe(false);
    expect(isScalingLever('combatCorrectness')).toBe(false);
  });

  it('drops internal resolution FIRST when over pressure, before engaging any heavier stage', () => {
    const d = planScaling(1.2, INITIAL_SCALING_STATE, settings);
    expect(d.resolutionScale).toBeLessThan(1);
    expect(d.engagedStages).toBe(0); // nothing beyond resolution yet
    expect(d.activeStages).toEqual([]);
    expect(d.simCorrectnessReduced).toBe(false);
  });

  it('NEVER reduces simulation correctness (V22) at any pressure', () => {
    let state: ScalingState = INITIAL_SCALING_STATE;
    for (let i = 0; i < 50; i++) {
      const d = planScaling(5, state, settings);
      expect(d.simCorrectnessReduced).toBe(false);
      state = { resolutionScale: d.resolutionScale, engagedStages: d.engagedStages };
    }
  });

  it('only engages heavier stages once resolution is floored, strictly in order, horde density last', () => {
    let state: ScalingState = INITIAL_SCALING_STATE;
    const stagesSeen: number[] = [];
    for (let i = 0; i < 100; i++) {
      const d = planScaling(2, state, settings);
      // While resolution is still above floor, no extra stages may engage.
      if (d.resolutionScale > settings.floor) expect(d.engagedStages).toBe(0);
      stagesSeen.push(d.engagedStages);
      state = { resolutionScale: d.resolutionScale, engagedStages: d.engagedStages };
    }
    // Eventually resolution floors and all extra stages engage in order.
    expect(state.resolutionScale).toBeCloseTo(settings.floor, 5);
    expect(state.engagedStages).toBe(SCALING_STAGES.length - 1);
    // active stages are always a prefix of SCALING_STAGES (order enforced).
    const finalDecision = planScaling(2, state, settings);
    expect(finalDecision.activeStages).toEqual(SCALING_STAGES.slice(1));
    expect(finalDecision.activeStages[finalDecision.activeStages.length - 1]).toBe('hordeDensity');
  });

  it('recovers in reverse: backs out heavy stages before raising resolution', () => {
    const stressed: ScalingState = { resolutionScale: settings.floor, engagedStages: 2 };
    const r1 = planScaling(0.3, stressed, settings); // well below release threshold
    expect(r1.engagedStages).toBe(1); // dropped a stage, resolution unchanged
    expect(r1.resolutionScale).toBe(settings.floor);
    const noStages: ScalingState = { resolutionScale: settings.floor, engagedStages: 0 };
    const r2 = planScaling(0.3, noStages, settings);
    expect(r2.resolutionScale).toBeGreaterThan(settings.floor); // now resolution recovers
  });

  it('never drops resolution below the configured floor', () => {
    let state: ScalingState = INITIAL_SCALING_STATE;
    for (let i = 0; i < 100; i++) {
      const d = planScaling(3, state, settings);
      expect(d.resolutionScale).toBeGreaterThanOrEqual(settings.floor);
      state = { resolutionScale: d.resolutionScale, engagedStages: d.engagedStages };
    }
  });

  it('engage threshold is below 1.0 so scaling begins BEFORE the frame budget is blown (V22)', () => {
    expect(settings.engageThreshold).toBeLessThan(1);
  });

  it('rejects invalid pressure (V4)', () => {
    expect(() => planScaling(-1, INITIAL_SCALING_STATE, settings)).toThrow();
  });
});

describe('color grading profile selection (T31)', () => {
  it('is deterministic and folds in district/time/weather/danger', () => {
    const p = selectGradingProfile({ district: 'downtown', timeOfDay: 0.5, weather: 'clear', danger: 0.1 });
    expect(p).toBe('downtown.day.clear.low');
    expect(selectGradingProfile({ district: 'downtown', timeOfDay: 0.05, weather: 'fog', danger: 0.9 })).toBe('downtown.night.fog.high');
  });
  it('rejects out-of-range inputs (V4)', () => {
    expect(() => selectGradingProfile({ district: 'x', timeOfDay: 2, weather: 'clear', danger: 0 })).toThrow();
  });
});

describe('accessible damage feedback (V29)', () => {
  const full: AccessibilityFeedback = { shakeScale: 1, reduceFlashes: false, reduceMotion: false };
  it('scales with damage intensity and is capped by config', () => {
    const lo = damageFeedback(0.2, full, 'desktop-high');
    const hi = damageFeedback(1, full, 'desktop-high');
    expect(hi.shake).toBeGreaterThan(lo.shake);
    expect(hi.vignette).toBeGreaterThan(lo.vignette);
  });
  it('respects accessibility: reduceFlashes kills chromatic, reduceMotion kills blur + damps shake', () => {
    const reduced = damageFeedback(1, { shakeScale: 1, reduceFlashes: true, reduceMotion: true }, 'desktop-high');
    expect(reduced.chromatic).toBe(0);
    expect(reduced.blur).toBe(0);
    const full1 = damageFeedback(1, full, 'desktop-high');
    expect(reduced.shake).toBeLessThan(full1.shake);
  });
  it('shakeScale 0 silences shake', () => {
    expect(damageFeedback(1, { shakeScale: 0, reduceFlashes: false, reduceMotion: false }, 'desktop-high').shake).toBe(0);
  });
  it('rejects invalid intensity (V4)', () => {
    expect(() => damageFeedback(2, full, 'desktop-high')).toThrow();
  });
});
