// T37 / V22 / V25 — tier selection from probe (limits + micro-benchmark), profile assembly,
// safe-limit override guard, and strict-order scaling controller that never touches sim correctness.

import { describe, it, expect } from 'vitest';
import { CapabilityError, type AdapterLimits } from '../engine/capability';
import { resolveDynamicResolutionSettings, SCALING_STAGES } from '../effects/postfx';
import {
  tierByBenchmark,
  detectTierFromProbe,
  assembleQualityProfile,
  evaluateTierOverride,
  resolveEffectiveProfile,
  ScalingController,
  createScalingController,
  STAGE_SYSTEMS,
  type MicroBenchmarkResult,
  type StartupProbe,
} from './tiers';
import type { QualityTier } from '../../config/types';

// Adapter limits comfortably clearing each tier's gate.
const LIMITS_HIGH: AdapterLimits = {
  maxTextureDimension2D: 16384,
  maxBufferSize: 2 * 1024 * 1024 * 1024,
  maxComputeWorkgroupStorageSize: 32768,
};
const LIMITS_MEDIUM: AdapterLimits = {
  maxTextureDimension2D: 8192,
  maxBufferSize: 700 * 1024 * 1024,
  maxComputeWorkgroupStorageSize: 32768,
};
const LIMITS_MOBILE: AdapterLimits = {
  maxTextureDimension2D: 4096,
  maxBufferSize: 150 * 1024 * 1024,
  maxComputeWorkgroupStorageSize: 16384,
};

// Benchmarks clearing each tier's measured-perf gate (frame budget high=6/med=10/compat=16/mobile=24).
const BENCH_HIGH: MicroBenchmarkResult = { gpuFrameMs: 5, fillRateScore: 120 };
const BENCH_MEDIUM: MicroBenchmarkResult = { gpuFrameMs: 9, fillRateScore: 70 };
const BENCH_COMPAT: MicroBenchmarkResult = { gpuFrameMs: 15, fillRateScore: 35 };
const BENCH_MOBILE: MicroBenchmarkResult = { gpuFrameMs: 22, fillRateScore: 12 };

describe('tierByBenchmark (V25 measured perf)', () => {
  it('reaches every tier from a matching measured benchmark', () => {
    expect(tierByBenchmark(BENCH_HIGH)).toBe('desktop-high');
    expect(tierByBenchmark(BENCH_MEDIUM)).toBe('desktop-medium');
    expect(tierByBenchmark(BENCH_COMPAT)).toBe('desktop-compat');
    expect(tierByBenchmark(BENCH_MOBILE)).toBe('mobile-webgpu');
  });

  it('demotes when frame time is fast but fill-rate is weak', () => {
    expect(tierByBenchmark({ gpuFrameMs: 4, fillRateScore: 35 })).toBe('desktop-compat');
  });

  it('throws (no invented fallback) when slower than the mobile floor', () => {
    expect(() => tierByBenchmark({ gpuFrameMs: 40, fillRateScore: 12 })).toThrow(CapabilityError);
  });

  it('rejects malformed benchmark values', () => {
    expect(() => tierByBenchmark({ gpuFrameMs: NaN, fillRateScore: 1 })).toThrow(CapabilityError);
    expect(() => tierByBenchmark({ gpuFrameMs: -1, fillRateScore: 1 })).toThrow(CapabilityError);
  });
});

describe('detectTierFromProbe (V25 limits + measured)', () => {
  it('resolves desktop-high when both limits and benchmark are strong', () => {
    const probe: StartupProbe = { limits: LIMITS_HIGH, benchmark: BENCH_HIGH };
    expect(detectTierFromProbe(probe)).toBe('desktop-high');
  });

  it('measured perf DEMOTES below the limit ceiling (strong limits, slow GPU)', () => {
    const probe: StartupProbe = { limits: LIMITS_HIGH, benchmark: BENCH_COMPAT };
    expect(detectTierFromProbe(probe)).toBe('desktop-compat');
  });

  it('measured perf NEVER promotes above the limit ceiling (weak limits, fast bench)', () => {
    const probe: StartupProbe = { limits: LIMITS_MOBILE, benchmark: BENCH_HIGH };
    expect(detectTierFromProbe(probe)).toBe('mobile-webgpu');
  });

  it('each tier is reachable when limits and benchmark agree', () => {
    expect(detectTierFromProbe({ limits: LIMITS_MEDIUM, benchmark: BENCH_MEDIUM })).toBe('desktop-medium');
    expect(detectTierFromProbe({ limits: LIMITS_MOBILE, benchmark: BENCH_MOBILE })).toBe('mobile-webgpu');
  });

  it('throws when the adapter cannot meet the mobile floor', () => {
    const probe: StartupProbe = {
      limits: { maxTextureDimension2D: 1024, maxBufferSize: 1, maxComputeWorkgroupStorageSize: 1 },
      benchmark: BENCH_HIGH,
    };
    expect(() => detectTierFromProbe(probe)).toThrow(CapabilityError);
  });
});

describe('assembleQualityProfile (config-sourced, progressively reduced)', () => {
  const tiers: QualityTier[] = ['desktop-high', 'desktop-medium', 'desktop-compat', 'mobile-webgpu'];

  it('assembles a full profile for every tier', () => {
    for (const t of tiers) {
      const p = assembleQualityProfile(t);
      expect(p.tier).toBe(t);
      expect(p.heroBudget).toBeGreaterThan(0);
      expect(p.hordeRenderBudget).toBeGreaterThan(0);
      expect(p.shadowDistanceMeters).toBeGreaterThan(0);
      expect(p.dynamicResolution.engageThreshold).toBeLessThan(1);
    }
  });

  it('desktop-high is the reference: richest hero/horde/shadow/residency budgets', () => {
    const high = assembleQualityProfile('desktop-high');
    const mobile = assembleQualityProfile('mobile-webgpu');
    expect(high.heroBudget).toBeGreaterThan(mobile.heroBudget);
    expect(high.hordeRenderBudget).toBeGreaterThan(mobile.hordeRenderBudget);
    expect(high.shadowDistanceMeters).toBeGreaterThan(mobile.shadowDistanceMeters);
    expect(high.shadowMapResolution).toBeGreaterThan(mobile.shadowMapResolution);
    expect(high.localLightBudget).toBeGreaterThan(mobile.localLightBudget);
    expect(high.textureResidencyChunks).toBeGreaterThan(mobile.textureResidencyChunks);
  });

  it('budgets are monotonically non-increasing high → medium → compat → mobile', () => {
    const profiles = tiers.map((t) => assembleQualityProfile(t));
    for (let i = 1; i < profiles.length; i++) {
      expect(profiles[i]!.heroBudget).toBeLessThanOrEqual(profiles[i - 1]!.heroBudget);
      expect(profiles[i]!.shadowDistanceMeters).toBeLessThanOrEqual(profiles[i - 1]!.shadowDistanceMeters);
    }
  });
});

describe('evaluateTierOverride (V25 safe-limit guard)', () => {
  it('uses detected tier when no override is set', () => {
    const d = evaluateTierOverride('desktop-medium', { qualityTierOverride: null });
    expect(d.effective).toBe('desktop-medium');
    expect(d.clamped).toBe(false);
  });

  it('accepts a less-demanding override within safe limits', () => {
    const d = evaluateTierOverride('desktop-high', { qualityTierOverride: 'desktop-compat' });
    expect(d.effective).toBe('desktop-compat');
    expect(d.clamped).toBe(false);
  });

  it('clamps (never allows) an override exceeding safe limits', () => {
    const d = evaluateTierOverride('desktop-medium', { qualityTierOverride: 'desktop-high' });
    expect(d.effective).toBe('desktop-medium');
    expect(d.clamped).toBe(true);
    expect(d.requested).toBe('desktop-high');
  });

  it('resolveEffectiveProfile reflects the clamped tier', () => {
    const safe = resolveEffectiveProfile('mobile-webgpu', { qualityTierOverride: 'desktop-high' });
    expect(safe.tier).toBe('mobile-webgpu');
    const high = assembleQualityProfile('desktop-high');
    expect(safe.heroBudget).toBeLessThan(high.heroBudget);
  });
});

describe('ScalingController (strict V22 order, sim correctness untouched)', () => {
  const settings = resolveDynamicResolutionSettings('desktop-high');

  it('engages dynamic resolution FIRST, before any heavier stage', () => {
    const ctrl = new ScalingController(settings);
    const d = ctrl.step(1.2);
    expect(d.resolutionScale).toBeLessThan(1);
    expect(d.engagedStages).toBe(0);
    expect(d.activeStages).toEqual([]);
  });

  it('steps down strictly in SCALING_STAGES order with horde density LAST', () => {
    const ctrl = new ScalingController(settings);
    for (let i = 0; i < 200; i++) {
      const d = ctrl.step(3);
      // active stages are always a prefix of the post-resolution stage list (order enforced).
      expect(d.activeStages).toEqual(SCALING_STAGES.slice(1, 1 + d.engagedStages));
    }
    const final = ctrl.current;
    expect(final.engagedStages).toBe(SCALING_STAGES.length - 1);
    const last = ctrl.step(3);
    expect(last.activeStages[last.activeStages.length - 1]).toBe('hordeDensity');
  });

  it('NEVER reduces simulation/combat correctness at any pressure', () => {
    const ctrl = new ScalingController(settings);
    for (let i = 0; i < 100; i++) {
      const d = ctrl.step(5);
      expect(d.simCorrectnessReduced).toBe(false);
    }
  });

  it('recovers in reverse order: heavy stages back out before resolution rises', () => {
    const ctrl = new ScalingController(settings, { resolutionScale: settings.floor, engagedStages: 2 });
    const r1 = ctrl.step(0.2);
    expect(r1.engagedStages).toBe(1);
    expect(r1.resolutionScale).toBe(settings.floor);
    ctrl.step(0.2); // drop last stage
    const r3 = ctrl.step(0.2);
    expect(r3.resolutionScale).toBeGreaterThan(settings.floor);
  });

  it('reset returns to the unscaled initial state', () => {
    const ctrl = new ScalingController(settings);
    ctrl.step(3);
    ctrl.reset();
    expect(ctrl.current).toEqual({ resolutionScale: 1, engagedStages: 0 });
  });

  it('createScalingController wires per-tier settings (mobile floor differs from high)', () => {
    const mobile = createScalingController('mobile-webgpu');
    const d = mobile.step(2);
    expect(d.resolutionScale).toBeLessThanOrEqual(1);
    expect(d.simCorrectnessReduced).toBe(false);
  });

  it('STAGE_SYSTEMS never lists a sim/combat-correctness system as a render lever', () => {
    const all = Object.values(STAGE_SYSTEMS).flat();
    expect(all).toContain('visibleHordeDensity');
    for (const s of all) {
      expect(s.toLowerCase()).not.toContain('combat');
      expect(s.toLowerCase()).not.toContain('simulation');
    }
  });
});
