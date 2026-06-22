// Config domain: rendering. Owned by lane R (render).
// V4 — every render tunable carries unit/owner/default/range/tier. No magic numbers in engine code.
// V25 — capability thresholds are expressed as per-tier minimum adapter limits: the tier-resolution
// machinery (resolve(spec, tier)) gives the minimum a GPU must report to QUALIFY for that tier.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const renderingConfig = registerDomain('rendering', {
  // ---- V25 capability gates (R15 GPU adapter limits) ----
  // For each tier we resolve the MINIMUM adapter limit required to be eligible for that tier.
  // detectQualityTier picks the highest tier whose every minimum is satisfied; mobile = floor.
  minMaxTextureDimension2D: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Minimum GPUSupportedLimits.maxTextureDimension2D required to qualify for a tier (V25/R15).',
    default: 4096, // mobile-webgpu floor
    min: 2048,
    max: 32768,
    integer: true,
    tiers: { 'desktop-high': 16384, 'desktop-medium': 8192, 'desktop-compat': 8192, 'mobile-webgpu': 4096 },
  }),
  minMaxBufferSize: num({
    owner: 'rendering',
    unit: 'bytes',
    doc: 'Minimum GPUSupportedLimits.maxBufferSize required to qualify for a tier (V25/R15).',
    default: 134217728, // 128 MiB mobile floor
    min: 67108864,
    max: 8589934592,
    integer: true,
    tiers: {
      'desktop-high': 1073741824, // 1 GiB
      'desktop-medium': 536870912, // 512 MiB
      'desktop-compat': 268435456, // 256 MiB
      'mobile-webgpu': 134217728, // 128 MiB
    },
  }),
  minMaxComputeWorkgroupStorageSize: num({
    owner: 'rendering',
    unit: 'bytes',
    doc: 'Minimum GPUSupportedLimits.maxComputeWorkgroupStorageSize required to qualify for a tier (V25/R15).',
    default: 16384, // mobile floor (WebGPU spec minimum)
    min: 16384,
    max: 65536,
    integer: true,
    tiers: {
      'desktop-high': 32768,
      'desktop-medium': 32768,
      'desktop-compat': 16384,
      'mobile-webgpu': 16384,
    },
  }),

  // ---- Output / frame ----
  pixelRatioMax: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Upper clamp on devicePixelRatio applied to the renderer (V22 scaling order).',
    default: 1.5,
    min: 0.5,
    max: 3,
    tiers: { 'desktop-high': 2, 'desktop-medium': 1.5, 'desktop-compat': 1, 'mobile-webgpu': 1.5 },
  }),

  // ---- Crowd instancing (T9 / V2) ----
  crowdInstanceCapacity: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Fixed capacity of the GPU instance buffer for the crowd InstancedMesh (V2/V10).',
    default: 2000,
    min: 64,
    max: 20000,
    integer: true,
    tiers: { 'desktop-high': 4000, 'desktop-medium': 2000, 'desktop-compat': 1000, 'mobile-webgpu': 500 },
  }),
  crowdVariationCount: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Number of distinct per-instance visual variation seeds for crowd diversity (T9).',
    default: 16,
    min: 1,
    max: 256,
    integer: true,
  }),
  crowdInstanceScaleMin: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Lower bound of per-instance scale variation applied during SoA->instance packing.',
    default: 0.9,
    min: 0.5,
    max: 1,
  }),
  crowdInstanceScaleMax: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Upper bound of per-instance scale variation applied during SoA->instance packing.',
    default: 1.1,
    min: 1,
    max: 2,
  }),

  // ---- Device-loss recovery (V23) ----
  deviceLossMaxRecoveries: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Max automatic WebGPU device-loss recoveries before session-safe shutdown (V23).',
    default: 3,
    min: 0,
    max: 10,
    integer: true,
  }),
});
