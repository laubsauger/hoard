// Config domain: rendering — crowd sub-domain field definitions (split from rendering.ts; no behavior change).
// Plain spec objects (NOT a registered domain); spread into registerDomain('rendering', …) by ../rendering.ts.

import { num } from '../../spec';

export const crowdFields = {
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
  // ---- Block-limbed crowd (T72 / V2 / V13 / V17): hero + active-crowd zombies read as FIGURES so
  // dismemberment is VISIBLE. Composed from 6 shared per-part InstancedMeshes (NO per-zombie mesh, V2),
  // pooled to a budget. Per-part box dims live in CROWD_LIMB_PARTS below (art-direction proportions). ----
  crowdLimbedBudget: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Max simultaneously limbed (figure) zombies — the hero+active-crowd pool cap; extra figures fall through (T30 LOD).',
    default: 64,
    min: 0,
    max: 512,
    integer: true,
    tiers: { 'desktop-high': 128, 'desktop-medium': 64, 'desktop-compat': 32, 'mobile-webgpu': 16 },
  }),
  crowdLimbedMaxSimTier: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'SoA simTier <= this is rendered as a limbed figure (0 hero, 1 active); higher tiers stay the instanced box (V13).',
    default: 1,
    min: 0,
    max: 3,
    integer: true,
  }),
  crowdLimbWalkSwingRadians: num({
    owner: 'rendering',
    unit: 'radians',
    doc: 'Peak arm/leg swing about local X driven by the SoA walk phase on limbed figures (idle/walk read).',
    default: 0.45,
    min: 0,
    max: 1.5,
  }),
  crowdLimbBobMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Peak vertical body bob applied to every part of a limbed figure on the WALK profile (idle/chase have their own — crowdLimbIdleBobMeters/crowdLimbChaseBobMeters).',
    default: 0.05,
    min: 0,
    max: 0.5,
  }),
  // ---- STATE-DRIVEN limb gait (T111 / V75): a limbed figure's swing/bob/reach reflect its SoA ZombieState +
  // per-zombie speed, NOT one generic walk curve. idle≈still breathing; walk = moderate counter-swing paced to
  // speed; chase = faster/wider/deeper bob; attack = a forward arm LUNGE (reach toward heading, not the
  // counter-swing). The pure `limbGait`/`gaitPhaseRateHz` (limbs.ts) consume these; unit-tested GPU-free. The
  // WALK swing/bob reuse crowdLimbWalkSwingRadians/crowdLimbBobMeters above; the rest are per-state below. ----
  crowdLimbIdleSwingRadians: num({
    owner: 'rendering',
    unit: 'radians',
    doc: 'Peak limb swing on the IDLE profile — a near-still breathing weight-shift, minimal motion (T111/V75).',
    default: 0.05,
    min: 0,
    max: 1.5,
  }),
  crowdLimbChaseSwingRadians: num({
    owner: 'rendering',
    unit: 'radians',
    doc: 'Peak limb swing on the CHASE (running) profile — wider + more agitated than the walk swing (T111/V75).',
    default: 0.85,
    min: 0,
    max: 2,
  }),
  crowdLimbIdleFreqHz: num({
    owner: 'rendering',
    unit: 'hz',
    doc: 'Animation-phase rate on the IDLE profile — slow breathing cadence; also the floor a slowing walker/chaser lerps back toward (T111/V75).',
    default: 0.4,
    min: 0,
    max: 8,
  }),
  crowdLimbWalkFreqHz: num({
    owner: 'rendering',
    unit: 'hz',
    doc: 'Animation-phase rate on the WALK profile at full pace; scaled down toward the idle rate as speed→0 (T111/V75).',
    default: 1.4,
    min: 0,
    max: 8,
  }),
  crowdLimbChaseFreqHz: num({
    owner: 'rendering',
    unit: 'hz',
    doc: 'Animation-phase rate on the CHASE profile at full pace — faster strides than walk (T111/V75).',
    default: 2.6,
    min: 0,
    max: 12,
  }),
  crowdLimbIdleBobMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Vertical body bob on the IDLE profile — a subtle breathing rise; also the floor moving profiles lerp from at speed 0 (T111/V75).',
    default: 0.012,
    min: 0,
    max: 0.5,
  }),
  crowdLimbChaseBobMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Vertical body bob on the CHASE profile — deeper than the walk bob (running gait) (T111/V75).',
    default: 0.12,
    min: 0,
    max: 0.5,
  }),
  crowdLimbAttackReachRadians: num({
    owner: 'rendering',
    unit: 'radians',
    doc: 'Peak FORWARD arm reach about the shoulder during the ATTACK lunge — both arms rotate toward the heading (a grasping reach), NOT the locomotion counter-swing (T111/V75).',
    default: 1.05,
    min: 0,
    max: 2.5,
  }),
  crowdLimbAttackFreqHz: num({
    owner: 'rendering',
    unit: 'hz',
    doc: 'Animation-phase rate during ATTACK — drives the grasping lunge pulse of the forward arm reach (T111/V75).',
    default: 3.2,
    min: 0,
    max: 12,
  }),
  crowdLimbGaitSpeedRefMetersPerSecond: num({
    owner: 'rendering',
    unit: 'metersPerSecond',
    doc: 'Movement speed at which a WALK/CHASE figure reaches its FULL swing amplitude + stride frequency; the locomotion factor is clamp(speed/this,0,1) so a barely-moving body shuffles and a sprinter swings fully (T111/V75).',
    default: 2.5,
    min: 0.1,
    max: 12,
  }),
};

// ---- Block-limbed figure layout (T72 / V2 / V13 / ART-DIRECTION) ----
// Stable, identity-mapped set of body parts composing a humanoid silhouette (~1.8 m tall, origin at the
// feet). Box dims + local offsets are art-direction proportions, not perf knobs, so they live as a typed
// constant here (centralized + named — no literals in render code, V4) rather than per-field tier specs.
// `region` ties a part to its SoA anatomyFlags sever bit so a severed limb HIDES (V17); a null region
// (torso) is never severable. `swingSign` drives the counter-swinging walk gait; `reachSign` drives the
// forward ATTACK arm reach (T111/V75 — arms only). Order is the part order.

/** Identity of a block-limb body part. Render-side only; maps to an AnatomyRegion for the sever-hide. */
export type CrowdLimbId = 'torso' | 'head' | 'armLeft' | 'armRight' | 'legLeft' | 'legRight';

export interface CrowdLimbPart {
  readonly id: CrowdLimbId;
  /** Box geometry size in meters [width, height, depth]. */
  readonly size: readonly [number, number, number];
  /** Local center offset from the feet origin (pre per-instance scale), meters [x, y, z]. */
  readonly offset: readonly [number, number, number];
  /** Walk-phase swing sign about local X (arms/legs counter-swing); 0 keeps the part rigid. */
  readonly swingSign: number;
  /**
   * ATTACK forward-reach sign about local X (T111/V75). Non-zero ONLY on the arms, and the SAME on both
   * arms (not counter-swing) so the attack lunge reaches BOTH arms toward the heading. -1 maps a positive
   * reach magnitude to a forward (toward local +Z / facing) rotation; 0 = the part never reaches.
   */
  readonly reachSign: number;
}

export const CROWD_LIMB_PARTS: readonly CrowdLimbPart[] = [
  { id: 'legLeft', size: [0.18, 0.85, 0.2], offset: [-0.13, 0.42, 0], swingSign: 1, reachSign: 0 },
  { id: 'legRight', size: [0.18, 0.85, 0.2], offset: [0.13, 0.42, 0], swingSign: -1, reachSign: 0 },
  { id: 'torso', size: [0.5, 0.75, 0.32], offset: [0, 1.2, 0], swingSign: 0, reachSign: 0 },
  { id: 'head', size: [0.3, 0.32, 0.3], offset: [0, 1.72, 0], swingSign: 0, reachSign: 0 },
  { id: 'armLeft', size: [0.14, 0.62, 0.16], offset: [-0.34, 1.2, 0], swingSign: -1, reachSign: -1 },
  { id: 'armRight', size: [0.14, 0.62, 0.16], offset: [0.34, 1.2, 0], swingSign: 1, reachSign: -1 },
];
