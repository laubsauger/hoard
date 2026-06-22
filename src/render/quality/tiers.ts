// T37 / V22 / V25 — quality tiers, capability detection from measured probe + adapter limits,
// user override with safe-limit guard, and the strict V22 scaling-order controller.
//
// V25 — tier is selected from MEASURED startup tests + GPU adapter limits, never browser name. The
// limit gates (capability.ts) establish a hard ceiling; the micro-benchmark can only DEMOTE below
// that ceiling, never promote above it. An unsupported device yields an explicit error (V4), never a
// silent invented default.
// V22 — scaling order is strict and machine-enforced via SCALING_STAGES/planScaling. Authoritative
// combat/sim correctness is NEVER a scaling lever; the controller asserts this on every step.
//
// Pure logic. Constructs NO GPU objects; fully unit-testable in node. All thresholds come from typed
// config (V4) — no magic numbers here.

import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import { shadowsConfig } from '../../config/domains/shadows';
import { lightingConfig } from '../../config/domains/lighting';
import { streamingConfig } from '../../config/domains/streaming';
import { QUALITY_TIERS, type QualityTier } from '../../config/types';
import {
  detectQualityTier,
  applyTierOverride,
  CapabilityError,
  type AdapterLimits,
} from '../engine/capability';
import {
  INITIAL_SCALING_STATE,
  planScaling,
  resolveDynamicResolutionSettings,
  isScalingLever,
  type ScalingStage,
  type ScalingState,
  type ScalingDecision,
  type DynamicResolutionSettings,
} from '../effects/postfx';

type RenderingConfig = typeof renderingConfig;

// ============================================================================
// 1. Capability detection — startup probe (adapter limits + micro-benchmark)
// ============================================================================

/** Result of the fixed reference micro-benchmark run once at startup (measured, device-independent). */
export interface MicroBenchmarkResult {
  /** Measured GPU frame time (ms) rendering the fixed reference probe scene. Lower = faster. */
  readonly gpuFrameMs: number;
  /** Measured fill/throughput score (normalized, device-independent). Higher = faster. */
  readonly fillRateScore: number;
}

/** Everything the tier resolver needs at startup: reported adapter limits + the measured benchmark. */
export interface StartupProbe {
  readonly limits: AdapterLimits;
  readonly benchmark: MicroBenchmarkResult;
}

function validateBenchmark(b: MicroBenchmarkResult): void {
  for (const [k, v] of Object.entries(b)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new CapabilityError(`benchmark '${k}' must be a non-negative finite number, got ${String(v)}`);
    }
  }
}

/**
 * Tier implied by the measured micro-benchmark alone: highest tier whose frame is within budget AND
 * whose fill-rate clears the floor. Throws if the device is slower than even the mobile floor (explicit
 * decision — no silent default, V4).
 */
export function tierByBenchmark(
  benchmark: MicroBenchmarkResult,
  config: RenderingConfig = renderingConfig,
): QualityTier {
  validateBenchmark(benchmark);
  for (const tier of QUALITY_TIERS) {
    const frameBudget = resolve(config.probeGpuFrameBudgetMs, tier);
    const minFill = resolve(config.probeMinFillRateScore, tier);
    if (benchmark.gpuFrameMs <= frameBudget && benchmark.fillRateScore >= minFill) return tier;
  }
  throw new CapabilityError(
    `measured GPU performance below the minimum supported tier (mobile-webgpu): ${JSON.stringify(benchmark)}`,
  );
}

/** Larger index = LESS demanding tier (QUALITY_TIERS is ordered most→least demanding). */
function tierIndex(tier: QualityTier): number {
  const i = QUALITY_TIERS.indexOf(tier);
  if (i < 0) throw new CapabilityError(`unknown tier '${tier}'`);
  return i;
}

/** The less-demanding (more conservative) of two tiers. */
function lessDemanding(a: QualityTier, b: QualityTier): QualityTier {
  return QUALITY_TIERS[Math.max(tierIndex(a), tierIndex(b))]!;
}

/**
 * V25 — resolve the detected tier from the full startup probe. The adapter-limit gate is a hard
 * ceiling; the measured benchmark may demote below it but never promote above it. The result is the
 * more conservative of the two signals.
 */
export function detectTierFromProbe(
  probe: StartupProbe,
  config: RenderingConfig = renderingConfig,
): QualityTier {
  const limitTier = detectQualityTier(probe.limits, config);
  const benchTier = tierByBenchmark(probe.benchmark, config);
  return lessDemanding(limitTier, benchTier);
}

// ============================================================================
// 2. Resolved per-tier render/quality profile (assembled from config domains)
// ============================================================================

/**
 * Fully resolved render profile for a tier. Every field is sourced from a typed config spec (V4) — this
 * module only assembles them. Reference (desktop-high) carries the richest values; medium/compat/mobile
 * progressively reduce via the per-tier config overrides.
 */
export interface QualityProfile {
  readonly tier: QualityTier;
  /** Output: devicePixelRatio clamp (V22 #1 internal resolution headroom). */
  readonly pixelRatioMax: number;
  /** Crowd: max simultaneously promoted hero (skinned) zombies (V13). */
  readonly heroBudget: number;
  /** Crowd: GPU instance buffer capacity = the render-side visible-horde budget (V22 #6, scaled LAST). */
  readonly hordeRenderBudget: number;
  /** Shadows: max world distance receiving directional shadows (V22 #2). */
  readonly shadowDistanceMeters: number;
  /** Shadows: per-cascade shadow map edge resolution (V22 #2). */
  readonly shadowMapResolution: number;
  /** Shadows: directional cascade count (V22 #2). */
  readonly shadowCascades: number;
  /** Shadows: dynamic local lights allowed to cast this frame (V22 #2 secondary casters). */
  readonly localCasterBudget: number;
  /** Lighting: max simultaneously active dynamic local lights (V22 #5). */
  readonly localLightBudget: number;
  /** Lighting: near-player ambient occlusion strength (reference lighting fidelity). */
  readonly ambientOcclusionStrength: number;
  /** Texture/asset residency: max render chunks held at high detail (V22 #4 texture residency). */
  readonly textureResidencyChunks: number;
  /** Dynamic-resolution + scaling thresholds for this tier (drives the scaling controller). */
  readonly dynamicResolution: DynamicResolutionSettings;
}

/** Assemble the resolved profile for a tier from the render/shadow/lighting/streaming config domains. */
export function assembleQualityProfile(
  tier: QualityTier,
  config: RenderingConfig = renderingConfig,
): QualityProfile {
  if (tierIndex(tier) < 0) throw new CapabilityError(`unknown tier '${tier}'`);
  return {
    tier,
    pixelRatioMax: resolve(config.pixelRatioMax, tier),
    heroBudget: resolve(config.crowdHeroBudget, tier),
    hordeRenderBudget: resolve(config.crowdInstanceCapacity, tier),
    shadowDistanceMeters: resolve(shadowsConfig.shadowMaxDistanceMeters, tier),
    shadowMapResolution: resolve(shadowsConfig.shadowMapResolution, tier),
    shadowCascades: resolve(shadowsConfig.cascadeCount, tier),
    localCasterBudget: resolve(shadowsConfig.localCasterBudget, tier),
    localLightBudget: resolve(lightingConfig.localLightBudget, tier),
    ambientOcclusionStrength: resolve(lightingConfig.ambientOcclusionStrength, tier),
    textureResidencyChunks: resolve(streamingConfig.maxHighDetailChunks, tier),
    dynamicResolution: resolveDynamicResolutionSettings(tier),
  };
}

// ============================================================================
// 3. User override + safe-limit guard (V25)
// ============================================================================

/** Read-only view of the settings store slice we depend on (we never import/own the store). */
export interface TierOverrideSource {
  readonly qualityTierOverride: QualityTier | null;
}

/** Outcome of applying a user override against the detected (safe) tier. */
export interface OverrideDecision {
  /** The tier the user requested, or null when none is set. */
  readonly requested: QualityTier | null;
  /** The hardware-detected (safe-limit) tier. */
  readonly detected: QualityTier;
  /** The tier actually used: never more demanding than `detected`. */
  readonly effective: QualityTier;
  /** True when the request exceeded safe limits and was clamped down to `detected`. */
  readonly clamped: boolean;
}

/**
 * V25 — apply the stored user override but NEVER allow it to exceed safe resource limits. A
 * less/equal-demanding request is honored; a more-demanding one is clamped down to the detected tier
 * (recorded via `clamped`). A null override means "use detected".
 */
export function evaluateTierOverride(
  detected: QualityTier,
  source: TierOverrideSource,
): OverrideDecision {
  const requested = source.qualityTierOverride;
  if (requested == null) {
    return { requested: null, detected, effective: detected, clamped: false };
  }
  const effective = applyTierOverride(detected, requested);
  return { requested, detected, effective, clamped: effective !== requested };
}

/** Convenience: resolve the effective profile from a detected tier + the settings override source. */
export function resolveEffectiveProfile(
  detected: QualityTier,
  source: TierOverrideSource,
  config: RenderingConfig = renderingConfig,
): QualityProfile {
  return assembleQualityProfile(evaluateTierOverride(detected, source).effective, config);
}

// ============================================================================
// 4. Scaling-order controller (strict V22 order, sim correctness never reduced)
// ============================================================================

/** Render systems each V22 stage governs (diagnostics/clarity; sim correctness is deliberately absent). */
export const STAGE_SYSTEMS: Readonly<Record<ScalingStage, readonly string[]>> = {
  internalResolution: ['internalResolutionScale', 'expensivePostFX'],
  shadows: ['shadowDistance', 'shadowResolution', 'secondaryCasters'],
  crowdAnimFidelity: ['crowdAnimationFidelity', 'heroPromotionBudget'],
  lodAndTextures: ['lodAggressiveness', 'textureResidency'],
  secondaryEffects: ['debris', 'particles', 'persistentCorpses', 'dynamicLocalLights'],
  hordeDensity: ['visibleHordeDensity'],
};

/**
 * Drives the strict V22 scaling order from measured GPU pressure. Internally delegates each step to the
 * pure `planScaling` (which guarantees: dynamic resolution engages first, heavier stages engage only
 * once resolution is floored, strictly in SCALING_STAGES order with horde density LAST). The controller
 * holds the running state and asserts on every step that simulation/combat correctness was never made a
 * lever (V22) — a defensive, machine-checkable guard, not a fallback.
 */
export class ScalingController {
  private state: ScalingState;

  constructor(
    private readonly settings: DynamicResolutionSettings,
    initial: ScalingState = INITIAL_SCALING_STATE,
  ) {
    this.state = initial;
  }

  get current(): ScalingState {
    return this.state;
  }

  /** Advance one step under the given normalized GPU pressure (1.0 == exactly on budget). */
  step(pressure: number): ScalingDecision {
    const decision = planScaling(pressure, this.state, this.settings);
    // V22 invariant: authoritative combat/sim correctness is NEVER a scaling lever.
    if (decision.simCorrectnessReduced !== false) {
      throw new Error('V22 violation: scaling decision attempted to reduce simulation correctness');
    }
    for (const stage of decision.activeStages) {
      if (!isScalingLever(stage)) {
        throw new Error(`V22 violation: '${stage}' is not a permitted scaling lever`);
      }
    }
    this.state = { resolutionScale: decision.resolutionScale, engagedStages: decision.engagedStages };
    return decision;
  }

  reset(): void {
    this.state = INITIAL_SCALING_STATE;
  }
}

/** Build a scaling controller wired to a tier's dynamic-resolution settings. */
export function createScalingController(tier: QualityTier): ScalingController {
  return new ScalingController(resolveDynamicResolutionSettings(tier));
}

export { SCALING_STAGES, type ScalingStage } from '../effects/postfx';
