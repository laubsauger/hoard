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

  // ---- V25 startup micro-benchmark gates (measured perf, NOT browser name) ----
  // detectTierFromProbe combines these with the adapter-limit gates above: a device qualifies for a
  // tier only if it BOTH satisfies that tier's minimum adapter limits AND its measured probe frame is
  // within budget AND its measured fill-rate score clears the floor. Measured perf can only DEMOTE
  // below the limit ceiling, never promote above it. Below the mobile floor → explicit error (V4).
  probeGpuFrameBudgetMs: num({
    owner: 'rendering',
    unit: 'ms',
    doc: 'Max measured GPU frame time (ms) at the fixed reference probe scene to qualify for a tier (V25).',
    default: 24, // mobile-webgpu ceiling — slower than this fails every tier
    min: 1,
    max: 100,
    tiers: {
      'desktop-high': 6,
      'desktop-medium': 10,
      'desktop-compat': 16,
      'mobile-webgpu': 24,
    },
  }),
  probeMinFillRateScore: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Min measured device-independent fill/throughput score from the startup probe to qualify for a tier (V25).',
    default: 10, // mobile floor
    min: 0,
    max: 1000,
    tiers: {
      'desktop-high': 100,
      'desktop-medium': 60,
      'desktop-compat': 30,
      'mobile-webgpu': 10,
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
  // ---- Crowd GPU-compute transform/animation (T9 / V2 GPU-readable animation data) ----
  crowdAnimPhaseSpeed: num({
    owner: 'rendering',
    unit: 'hz',
    doc: 'Cycles/sec the crowd compute shader advances each instance animation phase (drives the walk bob).',
    default: 1.4,
    min: 0,
    max: 8,
  }),
  crowdAnimBobMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Peak vertical bob amplitude applied per instance from the GPU-advanced animation phase.',
    default: 0.06,
    min: 0,
    max: 1,
  }),
  crowdVariationBrightnessSpread: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Per-instance shader brightness spread (+/-) around the base crowd colour, keyed by variation seed.',
    default: 0.2,
    min: 0,
    max: 0.9,
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

  // ---- Crowd render paths (T30 / V2): hero / instanced / horde-LOD / impostor selected by tier+distance ----
  crowdHeroBudget: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Max simultaneously promoted hero (skinned-mesh) zombies — detailed hero band (V13/§V-gates 20-40).',
    default: 30,
    min: 0,
    max: 120,
    integer: true,
    tiers: { 'desktop-high': 40, 'desktop-medium': 30, 'desktop-compat': 16, 'mobile-webgpu': 8 },
  }),
  crowdHeroMaxDistanceMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Beyond this distance a hero-tier zombie is downgraded to the instanced animated path.',
    default: 18,
    min: 1,
    max: 200,
    tiers: { 'desktop-high': 24, 'desktop-compat': 12, 'mobile-webgpu': 9 },
  }),
  crowdInstancedMaxDistanceMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Beyond this distance the instanced animated path downgrades to the horde-LOD path.',
    default: 45,
    min: 2,
    max: 400,
    tiers: { 'desktop-high': 60, 'desktop-compat': 32, 'mobile-webgpu': 24 },
  }),
  crowdHordeLodMaxDistanceMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Beyond this distance the horde-LOD path downgrades to the far impostor/cluster path.',
    default: 110,
    min: 4,
    max: 800,
    tiers: { 'desktop-high': 150, 'desktop-compat': 80, 'mobile-webgpu': 55 },
  }),
  crowdMaterialFamilyCount: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Number of shared crowd material families (flesh/clothing/armor/burned ...); NO per-zombie material (V2).',
    default: 4,
    min: 1,
    max: 16,
    integer: true,
  }),

  // ---- Per-instance variation modules (T30): composed, never a unique shader/material (V2) ----
  crowdBodyVariantCount: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Body mesh-module variants packed in the shared crowd atlas (variation, not new materials).',
    default: 6,
    min: 1,
    max: 64,
    integer: true,
  }),
  crowdHeadVariantCount: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Head module variants in the shared atlas.',
    default: 8,
    min: 1,
    max: 64,
    integer: true,
  }),
  crowdHairVariantCount: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Hair module variants in the shared atlas.',
    default: 6,
    min: 1,
    max: 64,
    integer: true,
  }),
  crowdClothingVariantCount: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Clothing module variants in the shared atlas.',
    default: 10,
    min: 1,
    max: 64,
    integer: true,
  }),
  crowdPaletteCount: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Palette/mask swatches for tinting variation (dirt/blood layered separately).',
    default: 12,
    min: 1,
    max: 256,
    integer: true,
  }),

  // ---- Gore render (T19 / V8 / V29): pooled + capped; intensity multiplier injected from accessibility ----
  goreSprayPoolSize: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Fixed pool capacity for directional blood spray/mist emitters (recycled oldest-first when full).',
    default: 64,
    min: 0,
    max: 1024,
    integer: true,
    tiers: { 'desktop-high': 128, 'desktop-medium': 64, 'desktop-compat': 32, 'mobile-webgpu': 16 },
  }),
  goreStainPoolSize: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Fixed pool capacity for persistent readable blood stains/decals.',
    default: 256,
    min: 0,
    max: 4096,
    integer: true,
    tiers: { 'desktop-high': 512, 'desktop-medium': 256, 'desktop-compat': 128, 'mobile-webgpu': 48 },
  }),
  goreSeverPoolSize: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Fixed pool capacity for sever-silhouette / wound-cap gore markers.',
    default: 48,
    min: 0,
    max: 512,
    integer: true,
    tiers: { 'desktop-high': 96, 'desktop-medium': 48, 'desktop-compat': 24, 'mobile-webgpu': 8 },
  }),
  goreSprayParticlesPerEvent: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Particles emitted per hero blood-spray event at full gore intensity (scaled by accessibility + distance).',
    default: 12,
    min: 1,
    max: 200,
    integer: true,
    tiers: { 'desktop-high': 20, 'desktop-compat': 8, 'mobile-webgpu': 4 },
  }),
  goreDistantSimplifyMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Beyond this distance gore uses the pooled simplified form (no hero wet response).',
    default: 20,
    min: 1,
    max: 200,
  }),

  // ---- Combat feedback (B7 — muzzle flash / tracer / impact spark fed by VisualEvent + fire) ----
  combatSparkLifetimeSeconds: num({
    owner: 'rendering',
    unit: 'seconds',
    doc: 'Lifetime of a pooled impact-spark/blood marker spawned from a hit VisualEvent before it is recycled (B7).',
    default: 0.4,
    min: 0.05,
    max: 5,
  }),
  combatMuzzleFlashSeconds: num({
    owner: 'rendering',
    unit: 'seconds',
    doc: 'Duration of the muzzle-flash light + sprite pulse on player fire (B7).',
    default: 0.06,
    min: 0.01,
    max: 1,
  }),
  combatTracerSeconds: num({
    owner: 'rendering',
    unit: 'seconds',
    doc: 'Duration the shot tracer segment stays visible after firing (B7).',
    default: 0.08,
    min: 0.01,
    max: 1,
  }),
  combatMuzzleFlashIntensity: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Peak intensity of the muzzle-flash point light at full feedback before accessibility flash reduction (B7).',
    default: 6,
    min: 0,
    max: 50,
  }),
  combatTracerRangeMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Max length of the rendered shot tracer (the clean-miss length; a hit terminates at the struck-body travel — B15/V49).',
    default: 30,
    min: 1,
    max: 400,
  }),

  // ---- Gore overhaul (B14/T71/V48): directional velocity spray from the struck region height + ground splat ----
  // No magic numbers — the region->height map, particle ballistics, splat size + lifetime are all typed here.
  combatGoreSprayParticleSizeMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Base edge length of ONE billboarded blood droplet quad. Energy only nudges it within sane bounds — never a meters-scale square (V48/B14).',
    default: 0.07,
    min: 0.01,
    max: 0.5,
    tiers: { 'desktop-high': 0.08, 'desktop-compat': 0.06, 'mobile-webgpu': 0.05 },
  }),
  combatGoreSprayVelocityMps: num({
    owner: 'rendering',
    unit: 'metersPerSecond',
    doc: 'Initial droplet speed launched ALONG the impact vector (hitReaction dirX/dirZ) before the gravity settle (V48).',
    default: 5,
    min: 0,
    max: 40,
  }),
  combatGoreSprayUpwardMps: num({
    owner: 'rendering',
    unit: 'metersPerSecond',
    doc: 'Initial upward component giving the spray its arc before gravity pulls droplets back down (V48).',
    default: 2.5,
    min: 0,
    max: 40,
  }),
  combatGoreSpraySpreadMps: num({
    owner: 'rendering',
    unit: 'metersPerSecond',
    doc: 'Peak lateral (perpendicular-to-impact) velocity spread per droplet — the fan of the spray (V48).',
    default: 2,
    min: 0,
    max: 40,
  }),
  combatGoreSprayGravityMps2: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Downward acceleration (m/s^2) applied over a droplet lifetime so the spray settles toward the ground (V48).',
    default: 9.81,
    min: 0,
    max: 40,
  }),
  combatGoreStainSizeMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Edge length of the persistent flattened ground-splat decal at the projected impact point (V48).',
    default: 0.45,
    min: 0.05,
    max: 5,
    tiers: { 'desktop-high': 0.55, 'mobile-webgpu': 0.35 },
  }),
  combatGoreStainLifetimeSeconds: num({
    owner: 'rendering',
    unit: 'seconds',
    doc: 'How long a ground splat stays before fading out — readable persistent stain, far longer than the airborne spark lifetime (V48).',
    default: 9,
    min: 0.5,
    max: 120,
    tiers: { 'desktop-high': 12, 'mobile-webgpu': 5 },
  }),
  combatGoreHeightHeadMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'World height above the body base at which head/neck hits emit blood (region->height map, V48).',
    default: 1.7,
    min: 0,
    max: 5,
  }),
  combatGoreHeightTorsoMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'World height above the body base for torso/arm hits — the mid band (region->height map, V48).',
    default: 1.1,
    min: 0,
    max: 5,
  }),
  combatGoreHeightLegMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'World height above the body base for leg hits — the low band (region->height map, V48).',
    default: 0.4,
    min: 0,
    max: 5,
  }),

  // ---- Visibility / cutaway (T28 / V20): roof+upper-wall fade, base preserved, interiors stay hidden ----
  roofFadeSeconds: num({
    owner: 'rendering',
    unit: 'seconds',
    doc: 'Time to fade a roof/upper-wall section in or out as occlusion state changes (V20).',
    default: 0.25,
    min: 0,
    max: 5,
  }),
  wallPanelThicknessMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Thickness of a wall-shell panel (≪ navCell). Walls are thin oriented shells on exposed cell edges, not cell-filling blocks (B3).',
    default: 0.25,
    min: 0.02,
    max: 2,
  }),
  wallBasePreservedHeightMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Wall height (from floor up) always kept opaque to read enclosure + breach state (V20).',
    default: 1.2,
    min: 0.1,
    max: 10,
  }),
  upperWallFadeStartHeightMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Wall height above which sections may fade when they occlude the camera view (V20).',
    default: 1.8,
    min: 0.2,
    max: 20,
  }),
});
