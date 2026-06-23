// T29 / V8 / V22 — lighting logic. Budgeted shadow cascades + caster prioritization, dynamic local-light
// budget, near-player ambient/contact occlusion, atmospheric fog extinction + interior exposure
// transitions. Shadow casting is prioritized by screen contribution / tier / distance / threat (V22 #2).
// Pure logic, no GPU. GPU lights/targets are created by the renderer and tracked in the registry (V24).

import { resolve } from '../../config/spec';
import { shadowsConfig } from '../../config/domains/shadows';
import { lightingConfig } from '../../config/domains/lighting';
import type { QualityTier } from '../../config/types';

// ---- Shadow cascades ----

export interface CascadeSettings {
  readonly count: number;
  readonly splitLambda: number;
  readonly maxDistanceMeters: number;
  readonly mapResolution: number;
}

export function resolveCascadeSettings(tier: QualityTier): CascadeSettings {
  return {
    count: resolve(shadowsConfig.cascadeCount, tier),
    splitLambda: resolve(shadowsConfig.cascadeSplitLambda, tier),
    maxDistanceMeters: resolve(shadowsConfig.shadowMaxDistanceMeters, tier),
    mapResolution: resolve(shadowsConfig.shadowMapResolution, tier),
  };
}

/**
 * Practical-split-scheme cascade boundaries: blend uniform + logarithmic by lambda (0=uniform, 1=log).
 * Returns `count` far distances (the near plane is `near`, each split is the far edge of a cascade).
 */
export function computeCascadeSplits(near: number, far: number, count: number, lambda: number): number[] {
  if (near <= 0 || far <= near) throw new Error(`invalid cascade range near=${near} far=${far}`);
  if (!Number.isInteger(count) || count < 1) throw new Error(`cascade count must be a positive integer, got ${count}`);
  if (lambda < 0 || lambda > 1) throw new Error(`lambda must be in [0,1], got ${lambda}`);
  const splits: number[] = [];
  for (let i = 1; i <= count; i++) {
    const s = i / count;
    const logSplit = near * Math.pow(far / near, s);
    const uniformSplit = near + (far - near) * s;
    splits.push(lambda * logSplit + (1 - lambda) * uniformSplit);
  }
  return splits;
}

// ---- Shadow-caster prioritization (V22 #2) ----

export interface ShadowCaster {
  readonly id: number;
  /** Projected on-screen size 0..1 (screen contribution). */
  readonly screenContribution: number;
  /** Camera distance in meters. */
  readonly distanceMeters: number;
  /** Render-tier importance 0..1 (hero = 1). */
  readonly tierImportance: number;
  /** Gameplay threat 0..1 (active attacker near the player). */
  readonly threat: number;
}

export interface CasterPriorityWeights {
  readonly screen: number;
  readonly distance: number;
  readonly threat: number;
  readonly tier: number;
}

export function resolveCasterPriorityWeights(tier: QualityTier): CasterPriorityWeights {
  return {
    screen: resolve(shadowsConfig.priorityScreenWeight, tier),
    distance: resolve(shadowsConfig.priorityDistanceWeight, tier),
    threat: resolve(shadowsConfig.priorityThreatWeight, tier),
    tier: resolve(shadowsConfig.priorityTierWeight, tier),
  };
}

/** Priority score — higher casts first. Distance contributes as proximity (nearer = higher). */
export function casterScore(c: ShadowCaster, w: CasterPriorityWeights, maxDistanceMeters: number): number {
  if (maxDistanceMeters <= 0) throw new Error(`maxDistanceMeters must be positive, got ${maxDistanceMeters}`);
  const proximity = Math.max(0, 1 - c.distanceMeters / maxDistanceMeters);
  return (
    w.screen * c.screenContribution +
    w.distance * proximity +
    w.threat * c.threat +
    w.tier * c.tierImportance
  );
}

/**
 * Choose which casters cast shadows within `budget` (V22 #2 — secondary casters scale down first under
 * pressure). Sorts by descending score (stable by id on ties) and enables the top `budget`. Casters
 * beyond the max shadow distance are dropped regardless of score.
 */
export function prioritizeCasters(
  casters: readonly ShadowCaster[],
  budget: number,
  weights: CasterPriorityWeights,
  maxDistanceMeters: number,
): number[] {
  if (!Number.isInteger(budget) || budget < 0) throw new Error(`budget must be a non-negative integer, got ${budget}`);
  const eligible = casters.filter((c) => c.distanceMeters <= maxDistanceMeters);
  const scored = eligible
    .map((c) => ({ id: c.id, score: casterScore(c, weights, maxDistanceMeters) }))
    .sort((a, b) => (b.score - a.score) || (a.id - b.id));
  return scored.slice(0, budget).map((s) => s.id);
}

// ---- Dynamic local lights (V22 #5) ----

/**
 * Select the active dynamic local lights within budget, by descending importance. Stable by id on ties.
 * Returns the ids that stay lit; the rest are culled (an EARLY scaling victim before horde density, V22).
 */
export function selectActiveLights(
  lights: readonly { readonly id: number; readonly importance: number }[],
  budget: number,
): number[] {
  if (!Number.isInteger(budget) || budget < 0) throw new Error(`light budget must be a non-negative integer, got ${budget}`);
  return [...lights]
    .sort((a, b) => (b.importance - a.importance) || (a.id - b.id))
    .slice(0, budget)
    .map((l) => l.id);
}

export function resolveLocalLightBudget(tier: QualityTier): number {
  return resolve(lightingConfig.localLightBudget, tier);
}

// ---- Atmosphere / exposure ----

/** Beer-Lambert fog transmittance over a distance, scaled by weather severity 0..1. */
export function fogTransmittance(distanceMeters: number, weatherSeverity: number, tier: QualityTier): number {
  if (distanceMeters < 0) throw new Error(`distanceMeters must be non-negative, got ${distanceMeters}`);
  if (weatherSeverity < 0 || weatherSeverity > 1) throw new Error(`weatherSeverity must be in [0,1], got ${weatherSeverity}`);
  const base = resolve(lightingConfig.fogExtinctionPerMeter, tier);
  const maxMul = resolve(lightingConfig.weatherExtinctionMultiplierMax, tier);
  const extinction = base * (1 + weatherSeverity * (maxMul - 1));
  return Math.exp(-extinction * distanceMeters);
}

/**
 * Interpolate exposure compensation while crossing the interior/exterior threshold. `t` is 0 (fully
 * exterior) .. 1 (fully interior). Smoothstep so the transition reads as eyes adapting, not a snap.
 */
export function interiorExposure(t: number, tier: QualityTier): number {
  if (t < 0 || t > 1) throw new Error(`exposure transition t must be in [0,1], got ${t}`);
  const stops = resolve(lightingConfig.interiorExposureStops, tier);
  const smooth = t * t * (3 - 2 * t);
  return smooth * stops;
}

export interface FogDistances {
  readonly near: number;
  readonly far: number;
}

/**
 * Analytic linear-fog distances for the current weather severity (B5). The far plane is the distance at
 * which Beer-Lambert transmittance reaches the configured visibility floor — solved in CLOSED FORM
 * (far = -ln(transmittance) / extinction) rather than the old per-frame stepping loop that quantized far
 * into navCell-sized jumps (the bands that swept the near-ortho frame). The result is continuous in
 * severity and hard-clamped to [fogFarMin, fogFarMax]; near is a fixed fraction of far. Pure + monotonic:
 * worse weather => nearer far. The scene smooths the live fog toward these targets (decoupling, B5).
 */
export function resolveFogDistances(weatherSeverity: number, tier: QualityTier): FogDistances {
  if (weatherSeverity < 0 || weatherSeverity > 1) throw new Error(`weatherSeverity must be in [0,1], got ${weatherSeverity}`);
  const base = resolve(lightingConfig.fogExtinctionPerMeter, tier);
  const maxMul = resolve(lightingConfig.weatherExtinctionMultiplierMax, tier);
  const threshold = resolve(lightingConfig.fogVisibilityTransmittance, tier);
  const farMin = resolve(lightingConfig.fogFarMinMeters, tier);
  const farMax = resolve(lightingConfig.fogFarMaxMeters, tier);
  const nearRatio = resolve(lightingConfig.fogNearRatio, tier);
  if (farMin > farMax) throw new Error(`fog far band invalid: min ${farMin} > max ${farMax}`);

  const extinction = base * (1 + weatherSeverity * (maxMul - 1));
  // extinction is strictly positive (base > 0), so the closed-form distance is finite.
  const rawFar = -Math.log(threshold) / extinction;
  const far = Math.min(farMax, Math.max(farMin, rawFar));
  return { near: far * nearRatio, far };
}

/**
 * Exponentially approach a target value at `ratePerSecond` over `dtSeconds` (frame-rate independent).
 * Used to glide the live fog distances toward their analytic targets so a weather change never snaps the
 * fog boundary across the frame (B5). dt <= 0 snaps to target (construction-time prime).
 */
export function approach(current: number, target: number, ratePerSecond: number, dtSeconds: number): number {
  if (ratePerSecond < 0) throw new Error(`ratePerSecond must be non-negative, got ${ratePerSecond}`);
  if (dtSeconds <= 0) return target;
  const alpha = 1 - Math.exp(-ratePerSecond * dtSeconds);
  return current + (target - current) * alpha;
}

export interface ExposureInputs {
  /** Base exposure multiplier (postFX.baseExposure). */
  readonly baseExposure: number;
  /** Interior compensation in stops (output of interiorExposure(), 0 = exterior). */
  readonly interiorStops: number;
  /** Normalized scene brightness 0 (full dark / night) .. 1 (bright daylight). */
  readonly sceneBrightness: number;
  /** Extra stops applied at full darkness (lighting.nightExposureBoostStops). */
  readonly nightBoostStops: number;
}

/**
 * Resolve the renderer tone-mapping exposure (B6). Exposure compensation is expressed in STOPS and applied
 * multiplicatively (2^stops): the interior transition lifts exposure as the player enters an enclosure, and
 * a night term adds up to `nightBoostStops` extra stops as scene brightness falls to 0 — guaranteeing a
 * viewable floor at a low-key night spawn after AgX/ACES tone mapping. Pure + monotonic in both terms;
 * equals baseExposure exactly at full daylight, exterior. No magic numbers (all curve inputs are config).
 */
export function resolveToneExposure(i: ExposureInputs): number {
  if (i.baseExposure <= 0) throw new Error(`baseExposure must be positive, got ${i.baseExposure}`);
  if (i.interiorStops < 0) throw new Error(`interiorStops must be non-negative, got ${i.interiorStops}`);
  if (i.sceneBrightness < 0 || i.sceneBrightness > 1) throw new Error(`sceneBrightness must be in [0,1], got ${i.sceneBrightness}`);
  if (i.nightBoostStops < 0) throw new Error(`nightBoostStops must be non-negative, got ${i.nightBoostStops}`);
  const darkness = 1 - i.sceneBrightness;
  const nightStops = darkness * darkness * i.nightBoostStops; // ease-in: only deep dark gets the full lift
  const totalStops = i.interiorStops + nightStops;
  return i.baseExposure * Math.pow(2, totalStops);
}
