// T31 / V8 / V22 / V29 — post-processing + GPU-pressure scaling.
// Implements the STRICT V22 scaling order: (1) internal res + expensive postFX, (2) shadow dist/res +
// secondary casters, (3) crowd anim fidelity + hero promotion budget, (4) LOD aggressiveness + texture
// residency, (5) debris/particles/corpses/dynamic lights, (6) visible horde density LAST. Authoritative
// combat correctness is NEVER a scaling lever. Dynamic resolution engages BEFORE failure. Also: authored
// color-grading profile selection, selective bloom params, and sparse accessible damage feedback (V29).
// Pure logic, no GPU.

import { resolve } from '../../config/spec';
import { postFXConfig } from '../../config/domains/postFX';
import type { QualityTier } from '../../config/types';

// ---- V22 scaling order (strict, monotonic). Lower index = sacrificed first. ----
export const SCALING_STAGES = [
  'internalResolution', // (1) + expensive postFX
  'shadows', // (2) shadow distance/res + secondary casters
  'crowdAnimFidelity', // (3) crowd anim + hero promotion budget
  'lodAndTextures', // (4) LOD aggressiveness + texture residency
  'secondaryEffects', // (5) debris/particles/persistent corpses/dynamic local lights
  'hordeDensity', // (6) visible horde density — LAST
] as const;
export type ScalingStage = (typeof SCALING_STAGES)[number];

/**
 * Simulation correctness is intentionally NOT a member of SCALING_STAGES. This guard makes the V22
 * invariant ("NEVER reduce authoritative combat correctness to hide a render problem") machine-checkable.
 */
export function isScalingLever(name: string): name is ScalingStage {
  return (SCALING_STAGES as readonly string[]).includes(name);
}

export interface DynamicResolutionSettings {
  readonly floor: number;
  readonly step: number;
  readonly engageThreshold: number;
  readonly releaseThreshold: number;
}

export function resolveDynamicResolutionSettings(tier: QualityTier): DynamicResolutionSettings {
  return {
    floor: resolve(postFXConfig.dynamicResolutionFloor, tier),
    step: resolve(postFXConfig.dynamicResolutionStep, tier),
    engageThreshold: resolve(postFXConfig.gpuPressureEngageThreshold, tier),
    releaseThreshold: resolve(postFXConfig.gpuPressureReleaseThreshold, tier),
  };
}

export interface ScalingState {
  /** Current internal resolution scale 0..1 (1 = native). */
  readonly resolutionScale: number;
  /** How many stages BEYOND internalResolution are currently engaged (0..SCALING_STAGES.length-1). */
  readonly engagedStages: number;
}

export const INITIAL_SCALING_STATE: ScalingState = { resolutionScale: 1, engagedStages: 0 };

export interface ScalingDecision {
  readonly resolutionScale: number;
  readonly engagedStages: number;
  /** The stages currently active (always a prefix of SCALING_STAGES — order is enforced). */
  readonly activeStages: ScalingStage[];
  /** Always false here — present so callers can assert sim correctness is never touched (V22). */
  readonly simCorrectnessReduced: false;
}

/**
 * One adjustment step from a measured GPU pressure (normalized: 1.0 == exactly on frame budget, >1 over).
 * Behavior (V22):
 *  - pressure >= engageThreshold (which is < 1, so this fires BEFORE the frame budget is blown):
 *      first lower internal resolution toward the floor; only once at the floor do further-over-budget
 *      frames engage the next stages, strictly in SCALING_STAGES order. Horde density is the LAST stage.
 *  - pressure <= releaseThreshold: recover — back out the highest engaged stage, then raise resolution.
 * Simulation correctness is never a lever (simCorrectnessReduced is always false).
 */
export function planScaling(
  pressure: number,
  state: ScalingState,
  settings: DynamicResolutionSettings,
): ScalingDecision {
  if (!Number.isFinite(pressure) || pressure < 0) throw new Error(`pressure must be a non-negative finite number, got ${pressure}`);
  const { floor, step, engageThreshold, releaseThreshold } = settings;
  const maxExtraStages = SCALING_STAGES.length - 1; // stages after internalResolution

  let scale = state.resolutionScale;
  let stages = state.engagedStages;

  if (pressure >= engageThreshold) {
    // Step 1: drop internal resolution toward the floor BEFORE touching anything heavier.
    if (scale > floor) {
      scale = Math.max(floor, scale - step);
    } else if (stages < maxExtraStages) {
      // Resolution is floored and we are still over budget → engage the next stage, in order.
      stages += 1;
    }
  } else if (pressure <= releaseThreshold) {
    // Recover in reverse order: give back heavy stages first, then resolution last.
    if (stages > 0) {
      stages -= 1;
    } else if (scale < 1) {
      scale = Math.min(1, scale + step);
    }
  }

  const activeStages = SCALING_STAGES.slice(1, 1 + stages) as ScalingStage[];
  return { resolutionScale: scale, engagedStages: stages, activeStages, simCorrectnessReduced: false };
}

// ---- Authored color grading profiles (T31) ----

export interface GradingSelector {
  readonly district: string;
  /** 0..1 day fraction (0 = midnight). */
  readonly timeOfDay: number;
  readonly weather: 'clear' | 'rain' | 'fog' | 'smoke';
  /** 0..1 danger level. */
  readonly danger: number;
}

/** Profile id the renderer maps to an authored LUT. Pure deterministic selection (no magic in callers). */
export function selectGradingProfile(s: GradingSelector): string {
  if (s.timeOfDay < 0 || s.timeOfDay > 1) throw new Error(`timeOfDay must be in [0,1], got ${s.timeOfDay}`);
  if (s.danger < 0 || s.danger > 1) throw new Error(`danger must be in [0,1], got ${s.danger}`);
  const phase = s.timeOfDay < 0.25 || s.timeOfDay >= 0.85 ? 'night' : s.timeOfDay < 0.35 ? 'dawn' : s.timeOfDay < 0.7 ? 'day' : 'dusk';
  const danger = s.danger >= 0.66 ? 'high' : s.danger >= 0.33 ? 'med' : 'low';
  return `${s.district}.${phase}.${s.weather}.${danger}`;
}

// ---- Selective bloom (never universal haze) ----
export interface BloomSettings {
  readonly threshold: number;
  readonly intensity: number;
}
export function resolveBloomSettings(tier: QualityTier): BloomSettings {
  return {
    threshold: resolve(postFXConfig.bloomThreshold, tier),
    intensity: resolve(postFXConfig.bloomIntensity, tier),
  };
}

// ---- Sparse accessible damage feedback (V29) ----

export interface DamageFeedback {
  readonly shake: number;
  readonly vignette: number;
  readonly blur: number;
  readonly chromatic: number;
}

export interface AccessibilityFeedback {
  /** 0..1 camera-shake multiplier. */
  readonly shakeScale: number;
  /** Suppress flash/chromatic effects (photosensitivity). */
  readonly reduceFlashes: boolean;
  /** Global motion-reduction (also damps blur). */
  readonly reduceMotion: boolean;
}

/**
 * Compute damage feedback from a 0..1 damage intensity, capped by config and scaled by accessibility
 * settings (V29). reduceFlashes zeroes chromatic aberration; reduceMotion zeroes blur and damps shake.
 * The accessibility values are INJECTED (owned by the accessibility config domain, not this lane).
 */
export function damageFeedback(intensity: number, a: AccessibilityFeedback, tier: QualityTier): DamageFeedback {
  if (intensity < 0 || intensity > 1) throw new Error(`damage intensity must be in [0,1], got ${intensity}`);
  if (a.shakeScale < 0 || a.shakeScale > 1) throw new Error(`shakeScale must be in [0,1], got ${a.shakeScale}`);
  const shakeMax = resolve(postFXConfig.damageShakeMax, tier);
  const vignetteMax = resolve(postFXConfig.damageVignetteMax, tier);
  const blurMax = resolve(postFXConfig.damageBlurMax, tier);
  const chromaticMax = resolve(postFXConfig.damageChromaticMax, tier);
  return {
    shake: intensity * shakeMax * a.shakeScale * (a.reduceMotion ? 0.25 : 1),
    vignette: intensity * vignetteMax,
    blur: a.reduceMotion ? 0 : intensity * blurMax,
    chromatic: a.reduceFlashes ? 0 : intensity * chromaticMax,
  };
}
