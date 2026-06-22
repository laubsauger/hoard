// T5 / V25 / R15 — pure capability detection. Maps a GPU adapter-limits object to a QualityTier.
// NO browser-name sniffing (V25). Thresholds come from typed config (V4). Invalid input throws.
// This module constructs NO GPU objects and is fully unit-testable in node.

import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import { QUALITY_TIERS, type QualityTier } from '../../config/types';

/** Subset of GPUSupportedLimits we gate quality on (R15). Provided by the caller after adapter request. */
export interface AdapterLimits {
  readonly maxTextureDimension2D: number;
  readonly maxBufferSize: number;
  readonly maxComputeWorkgroupStorageSize: number;
}

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityError';
  }
}

type RenderingConfig = typeof renderingConfig;

function tierMinimums(config: RenderingConfig, tier: QualityTier): AdapterLimits {
  return {
    maxTextureDimension2D: resolve(config.minMaxTextureDimension2D, tier),
    maxBufferSize: resolve(config.minMaxBufferSize, tier),
    maxComputeWorkgroupStorageSize: resolve(config.minMaxComputeWorkgroupStorageSize, tier),
  };
}

function meets(limits: AdapterLimits, min: AdapterLimits): boolean {
  return (
    limits.maxTextureDimension2D >= min.maxTextureDimension2D &&
    limits.maxBufferSize >= min.maxBufferSize &&
    limits.maxComputeWorkgroupStorageSize >= min.maxComputeWorkgroupStorageSize
  );
}

function validateLimits(limits: AdapterLimits): void {
  for (const [k, v] of Object.entries(limits)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new CapabilityError(`adapter limit '${k}' must be a non-negative finite number, got ${String(v)}`);
    }
  }
}

/**
 * Pick the highest tier whose every minimum adapter limit is satisfied.
 * QUALITY_TIERS is ordered most->least demanding, so the first match is the best supported tier.
 * Throws if the device cannot even meet the mobile-webgpu floor (no silent invented fallback, V4).
 */
export function detectQualityTier(
  limits: AdapterLimits,
  config: RenderingConfig = renderingConfig,
): QualityTier {
  validateLimits(limits);
  for (const tier of QUALITY_TIERS) {
    if (meets(limits, tierMinimums(config, tier))) return tier;
  }
  throw new CapabilityError(
    `GPU adapter limits below the minimum supported tier (mobile-webgpu): ${JSON.stringify(limits)}`,
  );
}

/**
 * V25 — store the user's tier override but never let it exceed measured capability.
 * Returns the safe effective tier: if the requested tier is MORE demanding than detected,
 * clamp down to detected; a less-demanding request is honored.
 */
export function applyTierOverride(detected: QualityTier, requested: QualityTier): QualityTier {
  const detIdx = QUALITY_TIERS.indexOf(detected);
  const reqIdx = QUALITY_TIERS.indexOf(requested);
  if (detIdx < 0) throw new CapabilityError(`unknown detected tier '${detected}'`);
  if (reqIdx < 0) throw new CapabilityError(`unknown requested tier '${requested}'`);
  // Larger index = less demanding. Effective must not be more demanding than detected.
  const safeIdx = Math.max(reqIdx, detIdx);
  return QUALITY_TIERS[safeIdx]!;
}
