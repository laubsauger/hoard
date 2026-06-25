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
  // ---- Crowd LOD distance bands (T140): rigged near/mid up to crowdRiggedMaxDistanceMeters, billboard
  // IMPOSTOR beyond. There is NO box LOD and NO count budget anymore — every in-view, alive zombie within the
  // rigged distance renders as a full GPU-skinned rigged figure; only the FAR band degrades to a baked
  // multi-angle billboard impostor (a zombie silhouette, never a box). The count is bounded only by the sim's
  // zombie cap (crowdInstanceCapacity) + frustum / vision-cone culling. ----
  crowdRiggedMaxDistanceMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Max distance (m, from the player/camera anchor) a zombie renders as a full RIGGED GPU-skinned figure; beyond this it degrades to the baked billboard impostor. No count budget — every in-view alive zombie within this radius is rigged (the sim cap + culling bound the total).',
    default: 80,
    min: 8,
    max: 600,
    tiers: { 'desktop-high': 110, 'desktop-medium': 80, 'desktop-compat': 55, 'mobile-webgpu': 38 },
  }),
  crowdImpostorAngleCount: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Number of azimuthal yaw views baked into each archetype’s billboard-impostor sprite atlas (T140). The far billboard samples the tile nearest the view-vs-facing azimuth; more tiles = smoother turn, larger atlas.',
    default: 12,
    min: 4,
    max: 32,
    integer: true,
    tiers: { 'desktop-high': 16, 'desktop-medium': 12, 'desktop-compat': 8, 'mobile-webgpu': 8 },
  }),
  crowdImpostorTileHeightPx: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Per-yaw tile HEIGHT (px) of the baked impostor sprite atlas (T140). The tile width is derived from this and the figure aspect. Small — the impostor only covers the far band.',
    default: 160,
    min: 32,
    max: 512,
    integer: true,
    tiers: { 'desktop-high': 192, 'desktop-medium': 160, 'desktop-compat': 128, 'mobile-webgpu': 96 },
  }),
  crowdImpostorMaxTriangles: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Upper bound on triangles sampled per archetype when CPU-rasterizing the impostor silhouette atlas at bake (T140). A denser GLB is uniformly strided down to this so the one-time bake stays fast; a far billboard does not need full density.',
    default: 60000,
    min: 2000,
    max: 400000,
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
  /**
   * Distance (pre-scale meters) from the box CENTER up to the JOINT it swings from — half the box height for a
   * limb (hip at the top of a leg, shoulder at the top of an arm). The walk/reach rotation pivots about this
   * joint, not the limb midpoint (T122/V87), so the joint stays anchored to the torso while the segment swings
   * below it. 0 = the part never swings (torso/head), so the pivot has no effect.
   */
  readonly pivotLen: number;
  /** Walk-phase swing sign about local X (arms/legs counter-swing); 0 keeps the part rigid. */
  readonly swingSign: number;
  /**
   * ATTACK forward-reach sign about local X (T111/V75). Non-zero ONLY on the arms, and the SAME on both
   * arms (not counter-swing) so the attack lunge reaches BOTH arms toward the heading. -1 maps a positive
   * reach magnitude to a forward (toward local +Z / facing) rotation; 0 = the part never reaches.
   */
  readonly reachSign: number;
}

// pivotLen = size[1] / 2 for the swinging limbs (the joint sits at the top of the box: hip atop a leg, shoulder
// atop an arm); 0 for the rigid torso/head. The swing/reach rotation pivots about that joint (T122/V87).
export const CROWD_LIMB_PARTS: readonly CrowdLimbPart[] = [
  { id: 'legLeft', size: [0.18, 0.85, 0.2], offset: [-0.13, 0.42, 0], pivotLen: 0.425, swingSign: 1, reachSign: 0 },
  { id: 'legRight', size: [0.18, 0.85, 0.2], offset: [0.13, 0.42, 0], pivotLen: 0.425, swingSign: -1, reachSign: 0 },
  { id: 'torso', size: [0.5, 0.75, 0.32], offset: [0, 1.2, 0], pivotLen: 0, swingSign: 0, reachSign: 0 },
  { id: 'head', size: [0.3, 0.32, 0.3], offset: [0, 1.72, 0], pivotLen: 0, swingSign: 0, reachSign: 0 },
  { id: 'armLeft', size: [0.14, 0.62, 0.16], offset: [-0.34, 1.2, 0], pivotLen: 0.31, swingSign: -1, reachSign: -1 },
  { id: 'armRight', size: [0.14, 0.62, 0.16], offset: [0.34, 1.2, 0], pivotLen: 0.31, swingSign: 1, reachSign: -1 },
];
