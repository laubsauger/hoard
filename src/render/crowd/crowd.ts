// T9 / V2 / V33 — GPU-instanced animated crowd. ONE shared mesh family + ONE InstancedMesh; NO per-zombie
// object/shader/mixer. The authoritative simulation owns the SoA on the CPU (V3); each frame we compact the
// LIVE instances' inputs (pose + meta) into GPU storage buffers (packCrowdInputs), and a TSL COMPUTE shader
// assembles the per-instance transform mat4 + advances the animation phase on the GPU (V2 "GPU-readable
// animation data"). The material's positionNode reads the computed transform from the storage buffer.
// Resources are tracked for disposal (V24).
//
// V33 history: r171 bound the capacity-sized instanceMatrix array as a single UNIFORM buffer, overflowing
// the 65536-byte max-uniform-binding at high capacity and silently dropping the crowd. That required a
// manual interleaved-vertex-buffer hack. three r184 fixed this natively — InstanceNode now checks
// getUniformBufferLimit() and auto-falls-back to instanced vertex-buffer attributes — so the hack is gone.
// We go further: the instance transform is no longer a CPU-built instanceMatrix at all. It is produced by a
// compute shader into a storage buffer and consumed via material.positionNode (the canonical WebGPU/TSL path).

import { BoxGeometry, Color, InstancedMesh, Matrix4, type Object3D } from 'three';
import {
  MeshStandardNodeMaterial,
  type ComputeNode,
  type StorageBufferNode,
  type UniformNode,
} from 'three/webgpu';
import {
  Fn,
  cos,
  float,
  fract,
  instanceIndex,
  instancedArray,
  mat4,
  normalLocal,
  positionLocal,
  sin,
  transformNormal,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import type { FieldViews } from '../../game/core/contracts/soa';
import type { AnatomyRegion } from '../../game/core/contracts';
import { regionBit } from '../../game/combat/anatomy';
import { resolve } from '../../config/spec';
import {
  renderingConfig,
  CROWD_LIMB_PARTS,
  type CrowdLimbId,
  type CrowdLimbPart,
} from '../../config/domains/rendering';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import { FLOATS_PER_META, FLOATS_PER_POSE, packCrowdInputs, variationSeed } from './packing';
import type { VisionCull } from './visionCull';
import {
  composeLimbMatrix,
  packLimbInputs,
  walkBob,
  walkSwing,
  FLOATS_PER_LIMB_POSE,
  FLOATS_PER_MAT4,
  type LimbPartPlacement,
} from './limbs';

/** Base crowd flesh/clothing tint; per-instance variation modulates its brightness in the shader (V2). */
const CROWD_BASE_COLOR = 0x4a5a3a;
/** Limbed-figure tint — a touch brighter than the horde box so hero/active figures read against the mass. */
const CROWD_LIMB_COLOR = 0x52613f;
const TAU = Math.PI * 2;

export interface CrowdSettings {
  readonly capacity: number;
  readonly variationCount: number;
  readonly scaleMin: number;
  readonly scaleMax: number;
  readonly phaseSpeedHz: number;
  readonly bobMeters: number;
  readonly brightnessSpread: number;
  /** Limbed (figure) pool budget — hero+active-crowd zombies drawn as block-limbed figures (T72/V13). */
  readonly limbedBudget: number;
  /** Slots with simTier <= this are limbed figures; higher tiers stay the horde box. */
  readonly limbedMaxSimTier: number;
  readonly limbSwingRadians: number;
  readonly limbBobMeters: number;
}

export function resolveCrowdSettings(tier: QualityTier): CrowdSettings {
  return {
    capacity: resolve(renderingConfig.crowdInstanceCapacity, tier),
    variationCount: resolve(renderingConfig.crowdVariationCount, tier),
    scaleMin: resolve(renderingConfig.crowdInstanceScaleMin, tier),
    scaleMax: resolve(renderingConfig.crowdInstanceScaleMax, tier),
    phaseSpeedHz: resolve(renderingConfig.crowdAnimPhaseSpeed, tier),
    bobMeters: resolve(renderingConfig.crowdAnimBobMeters, tier),
    brightnessSpread: resolve(renderingConfig.crowdVariationBrightnessSpread, tier),
    limbedBudget: resolve(renderingConfig.crowdLimbedBudget, tier),
    limbedMaxSimTier: resolve(renderingConfig.crowdLimbedMaxSimTier, tier),
    limbSwingRadians: resolve(renderingConfig.crowdLimbWalkSwingRadians, tier),
    limbBobMeters: resolve(renderingConfig.crowdLimbBobMeters, tier),
  };
}

/** Render part -> SoA anatomy region for the sever-hide (V17). Torso is never severable → null. */
const LIMB_REGION: Readonly<Record<CrowdLimbId, AnatomyRegion | null>> = {
  torso: null,
  head: 'head',
  armLeft: 'armLeft',
  armRight: 'armRight',
  legLeft: 'legLeft',
  legRight: 'legRight',
};

/**
 * The block-limbed figure path (T72): ONE shared InstancedMesh PER BODY PART (head/torso/armL/armR/legL/
 * legR), each instanced across the hero+active-tier (simTier <= limbedMaxSimTier) zombies and composed into
 * a humanoid silhouette per instance from the SoA pose + a SoA-phase walk swing/bob. A severed region
 * (its bit set in anatomyFlags) HIDES that part's instance (zero matrix) so dismemberment READS (V17). NO
 * per-zombie object/mesh (V2); pooled to limbedBudget and tracked for disposal (V24). r184 binding-safe:
 * solid box geo + pre-created instanceColor; CPU-built instanceMatrix (small budget, no compute needed).
 * Construction is GPU-free (three core InstancedMesh/BoxGeometry); only frame submission needs a device.
 */
export class CrowdLimbs {
  /** One InstancedMesh per body part, parented under the crowd group; same draw order as CROWD_LIMB_PARTS. */
  readonly meshes: readonly InstancedMesh[];

  private readonly material: MeshStandardNodeMaterial;
  private readonly placements: readonly LimbPartPlacement[];
  /** Per-part anatomy sever bit; 0 = never severable (torso). */
  private readonly severBits: readonly number[];
  private readonly budget: number;
  private readonly maxSimTier: number;
  private readonly swingRadians: number;
  private readonly bobMeters: number;
  private readonly variationCount: number;
  private readonly scaleMin: number;
  private readonly scaleMax: number;

  // Per-frame limbed inputs (compacted to the front) + scratch for instance-matrix composition.
  private readonly pose: Float32Array;
  private readonly scaleArr: Float32Array;
  private readonly anatomy: Uint32Array;
  private readonly phase: Float32Array;
  private readonly matScratch = new Float32Array(FLOATS_PER_MAT4);
  private readonly posScratch = new Float32Array(3);
  private readonly mat4 = new Matrix4();

  constructor(settings: CrowdSettings, registry: ResourceRegistry, parent: Object3D) {
    this.budget = settings.limbedBudget;
    this.maxSimTier = settings.limbedMaxSimTier;
    this.swingRadians = settings.limbSwingRadians;
    this.bobMeters = settings.limbBobMeters;
    this.variationCount = settings.variationCount;
    this.scaleMin = settings.scaleMin;
    this.scaleMax = settings.scaleMax;

    // One shared material family across all parts (no per-zombie/per-part material, V2).
    this.material = registry.track(
      new MeshStandardNodeMaterial({ color: CROWD_LIMB_COLOR, name: 'crowd.limb' }),
      'material',
      'crowd.limbMaterial',
    );

    const baseColor = new Color(CROWD_LIMB_COLOR);
    const meshes: InstancedMesh[] = [];
    for (const part of CROWD_LIMB_PARTS as readonly CrowdLimbPart[]) {
      const geo = registry.track(
        new BoxGeometry(part.size[0], part.size[1], part.size[2]),
        'geometry',
        `crowd.limbGeo.${part.id}`,
      );
      const mesh = new InstancedMesh(geo, this.material, this.budget);
      mesh.name = `crowd.limb.${part.id}`;
      mesh.count = 0;
      mesh.frustumCulled = false; // figures span the crowd bounds; cluster-cull later (T30)
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Pre-create instanceColor (r184 binding-safe) so the color attribute exists before first draw.
      for (let i = 0; i < this.budget; i++) mesh.setColorAt(i, baseColor);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      registry.track(mesh, 'buffer', `crowd.limbMesh.${part.id}`);
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.meshes = meshes;
    this.placements = CROWD_LIMB_PARTS.map((p) => ({ offset: p.offset, swingSign: p.swingSign }));
    this.severBits = CROWD_LIMB_PARTS.map((p) => {
      const region = LIMB_REGION[p.id];
      return region ? regionBit(region) : 0;
    });

    this.pose = new Float32Array(this.budget * FLOATS_PER_LIMB_POSE);
    this.scaleArr = new Float32Array(this.budget);
    this.anatomy = new Uint32Array(this.budget);
    this.phase = new Float32Array(this.budget);
  }

  /**
   * Compact the limbed-tier zombies and rebuild every part's instance matrices for this frame. Returns the
   * number of live limbed figures (also each part mesh's draw count). Severed parts get a zero (invisible)
   * matrix but keep their instance slot so indices stay aligned across parts.
   */
  update(views: FieldViews, count: number, visibility?: VisionCull): number {
    const { liveCount } = packLimbInputs(views, this.pose, this.scaleArr, this.anatomy, this.phase, {
      count,
      capacity: this.budget,
      variationCount: this.variationCount,
      scaleMin: this.scaleMin,
      scaleMax: this.scaleMax,
      maxSimTier: this.maxSimTier,
      visibility,
    });

    for (let part = 0; part < this.meshes.length; part++) {
      const mesh = this.meshes[part]!;
      const placement = this.placements[part]!;
      const bit = this.severBits[part]!;
      for (let i = 0; i < liveCount; i++) {
        const p = i * FLOATS_PER_LIMB_POSE;
        this.posScratch[0] = this.pose[p]!;
        this.posScratch[1] = this.pose[p + 1]!;
        this.posScratch[2] = this.pose[p + 2]!;
        const heading = this.pose[p + 3]!;
        const ph = this.phase[i]!;
        const visible = bit === 0 || (this.anatomy[i]! & bit) === 0;
        composeLimbMatrix(
          this.matScratch,
          0,
          this.posScratch,
          heading,
          this.scaleArr[i]!,
          placement,
          walkSwing(ph, this.swingRadians),
          walkBob(ph, this.bobMeters),
          visible,
        );
        this.mat4.fromArray(this.matScratch);
        mesh.setMatrixAt(i, this.mat4);
      }
      mesh.count = liveCount;
      mesh.instanceMatrix.needsUpdate = true;
    }
    return liveCount;
  }
}

/**
 * Owns the shared crowd InstancedMesh and its GPU storage buffers + compute node. Construction is CPU-only:
 * building TSL node graphs (instancedArray/Fn/compute/uniform) needs NO GPU device, so the Crowd can be
 * instantiated in node tests. Only renderer.compute(computeNode) execution needs the device — that happens
 * in the frame loop, not here. The pure compaction/packing lives in packCrowdInputs() and is unit-tested.
 */
export class Crowd {
  readonly mesh: InstancedMesh;
  readonly settings: CrowdSettings;
  /** The TSL compute node the frame loop runs (renderer.compute(crowd.computeNode)) before each render. */
  readonly computeNode: ComputeNode;
  /**
   * Hero+active-tier block-limbed figures (T72). Its per-part meshes are parented UNDER `mesh`, so the
   * scene wiring is unchanged: scene.add(crowd.mesh) brings the figures along and crowd.update() drives
   * them — no blockScene edit. The box `mesh` now draws ONLY the horde (simTier > limbedMaxSimTier).
   */
  readonly limbs: CrowdLimbs;

  private readonly geometry: BoxGeometry;
  private readonly material: MeshStandardNodeMaterial;

  // CPU-side input arrays (compacted live instances). Wrapped in storage buffers; re-uploaded each frame.
  private readonly poseInput: Float32Array;
  private readonly metaInput: Float32Array;
  private readonly poseBuffer: StorageBufferNode<'vec4'>;
  private readonly metaBuffer: StorageBufferNode<'vec4'>;
  /** Per-frame real delta fed to the GPU phase advance. */
  private readonly dtUniform: UniformNode<'float', number>;

  constructor(settings: CrowdSettings, registry: ResourceRegistry) {
    this.settings = settings;
    const cap = settings.capacity;

    // Shared mesh family placeholder (real archetype meshes land in T30). Capsule-ish box for the spike.
    this.geometry = registry.track(new BoxGeometry(0.5, 1.8, 0.4), 'geometry', 'crowd.geometry');
    this.material = registry.track(new MeshStandardNodeMaterial({ color: CROWD_BASE_COLOR }), 'material', 'crowd.material');
    this.mesh = new InstancedMesh(this.geometry, this.material, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // crowd spans large bounds; cull per-cluster later (T30)
    registry.track(this.mesh, 'buffer', 'crowd.instancedMesh');

    // Block-limbed hero/active figures, parented under the box mesh so the existing scene wiring carries
    // them (V2: shared per-part InstancedMeshes, no per-zombie mesh). The box mesh below draws the horde.
    this.limbs = new CrowdLimbs(settings, registry, this.mesh);

    // ---- GPU storage buffers (V24-tracked; StorageBufferNode is a disposable three Node) ----
    // Inputs: pose [px,py,pz,heading] and meta [scale,seed,archetype,animState], compacted per frame.
    this.poseInput = new Float32Array(cap * FLOATS_PER_POSE);
    this.metaInput = new Float32Array(cap * FLOATS_PER_META);
    this.poseBuffer = registry.track(instancedArray(this.poseInput, 'vec4'), 'buffer', 'crowd.poseBuffer');
    this.metaBuffer = registry.track(instancedArray(this.metaInput, 'vec4'), 'buffer', 'crowd.metaBuffer');

    // animPhase: GPU-resident animation phase state (V2). Seeded with per-slot offsets so instances are not
    // in lockstep, then advanced on the GPU each frame. The compute output is the per-instance transform
    // mat4, stored as FOUR per-instance vec4 column buffers: one entry per instance keeps each buffer at
    // capacity*16 bytes (<= the 65536 uniform limit) AND lets the material read them as instanced VERTEX
    // attributes via toAttribute() — the canonical zero-copy compute->render handoff (storage buffers are
    // not bindable in the vertex stage, so a single fat storage buffer would be (mis)bound as a uniform).
    const phaseSeed = new Float32Array(cap);
    for (let i = 0; i < cap; i++) phaseSeed[i] = variationSeed(i, Math.max(1, settings.variationCount)) / Math.max(1, settings.variationCount);
    const animPhase = registry.track(instancedArray(phaseSeed, 'float'), 'buffer', 'crowd.animPhase');
    const cols = [0, 1, 2, 3].map((k) => registry.track(instancedArray(cap, 'vec4'), 'buffer', `crowd.transformCol${k}`));

    this.dtUniform = uniform(0);
    const phaseSpeed = uniform(settings.phaseSpeedHz);
    const bobMeters = uniform(settings.bobMeters);

    // ---- Compute: assemble per-instance transform mat4 + advance animation phase (over capacity) ----
    this.computeNode = Fn(() => {
      const pose = this.poseBuffer.element(instanceIndex);
      const meta = this.metaBuffer.element(instanceIndex);
      const pos = pose.xyz;
      const heading = pose.w;
      const scale = meta.x;

      // Advance the GPU-resident phase, wrap to [0,1), and derive a subtle vertical walk-bob (V2).
      const phase = fract(animPhase.element(instanceIndex).add(phaseSpeed.mul(this.dtUniform))).toVar();
      animPhase.element(instanceIndex).assign(phase);
      const bob = sin(phase.mul(TAU)).mul(bobMeters);

      // Column-major TRS mat4. The rig's lateral axis is local +X (shoulders/hips) and its FORWARD is local
      // +Z (depth); so to FACE the movement direction the yaw maps local +Z → heading, i.e. yaw = heading - 90°
      // (was mapping local +X → heading, which pointed the shoulders along travel → the horde walked sideways).
      // heading = atan2(dirZ,dirX). Must stay in lockstep with composeLimbMatrix's facing.
      const facing = heading.sub(Math.PI / 2);
      const c = cos(facing);
      const s = sin(facing);
      cols[0]!.element(instanceIndex).assign(vec4(c.mul(scale), 0, s.mul(scale), 0));
      cols[1]!.element(instanceIndex).assign(vec4(0, scale, 0, 0));
      cols[2]!.element(instanceIndex).assign(vec4(s.mul(scale).negate(), 0, c.mul(scale), 0));
      cols[3]!.element(instanceIndex).assign(vec4(pos.x, pos.y.add(bob), pos.z, 1));
    })().compute(cap);

    // ---- Material: rebuild the transform from the computed instanced column attributes (positionNode) ----
    this.material.positionNode = Fn(() => {
      const m = mat4(cols[0]!.toAttribute(), cols[1]!.toAttribute(), cols[2]!.toAttribute(), cols[3]!.toAttribute());
      // Rotate the normal by the instance transform so per-instance lighting stays correct.
      normalLocal.assign(transformNormal(normalLocal, m));
      return m.mul(positionLocal).xyz;
    })();

    // Per-instance colour variation from the meta storage buffer (seed -> brightness band). NO new material.
    const base = new Color(CROWD_BASE_COLOR);
    const denom = Math.max(1, settings.variationCount - 1);
    const spread = settings.brightnessSpread;
    this.material.colorNode = Fn(() => {
      const seed = this.metaBuffer.toAttribute().y; // per-instance variation seed (vertex attr -> varying)
      const t = seed.div(denom); // 0..1 across the variation seeds
      const brightness = float(1 - spread).add(t.mul(spread * 2)); // [1-spread, 1+spread]
      return vec3(base.r, base.g, base.b).mul(brightness);
    })();

    // V65: reveal fade = material ALPHA, not scale. A member entering/leaving the player's awareness blends
    // smoothly instead of shrinking. transparent so alpha<1 composites; depthWrite kept so the solid bulk
    // (alpha 1) still occludes normally — the few fading members blend over what's behind them.
    this.material.transparent = true;
    // V65: reveal fade rides in meta.w (no extra vertex buffer — a separate fade attribute pushed the box over
    // the WebGPU 8-vertex-buffer limit). Members blend in/out via alpha instead of shrinking; transparent so
    // alpha<1 composites, depthWrite kept so the solid bulk still occludes normally.
    this.material.opacityNode = this.metaBuffer.toAttribute().w;
  }

  /**
   * Compact `count` SoA slots into the GPU input buffers, flag them for re-upload, and stage the frame
   * delta for the compute phase-advance. Returns the live instance count (also set as mesh.count so only
   * live instances are drawn). The transform mat4 itself is assembled later by renderer.compute(computeNode).
   */
  update(views: FieldViews, count: number, dtSeconds: number, visibility?: VisionCull): number {
    // The box draws the horde (simTier above the limbed band) PLUS any limbed-tier figures that overflowed the
    // limbed budget this frame — those fall through here instead of vanishing (§B culling fix). The figure /
    // box split is partitioned by a shared budget rank, so every alive zombie is drawn by exactly one path.
    const { liveCount } = packCrowdInputs(views, this.poseInput, this.metaInput, {
      count,
      capacity: this.settings.capacity,
      variationCount: this.settings.variationCount,
      scaleMin: this.settings.scaleMin,
      scaleMax: this.settings.scaleMax,
      limbedMaxSimTier: this.settings.limbedMaxSimTier,
      limbedBudget: this.settings.limbedBudget,
      visibility,
    });
    this.limbs.update(views, count, visibility);
    this.mesh.count = liveCount;
    // StorageBufferNode.value is the StorageInstancedBufferAttribute backing the buffer; bump it so the
    // backend re-uploads the freshly compacted inputs this frame. The compute reads these next. (meta carries
    // the V65 reveal alpha in .w.)
    (this.poseBuffer.value as { needsUpdate: boolean }).needsUpdate = true;
    (this.metaBuffer.value as { needsUpdate: boolean }).needsUpdate = true;
    this.dtUniform.value = dtSeconds;
    return liveCount;
  }
}
