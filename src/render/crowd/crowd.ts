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

import { BoxGeometry, Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, type Object3D } from 'three';
import {
  MeshStandardNodeMaterial,
  type ComputeNode,
  type StorageBufferNode,
  type UniformNode,
} from 'three/webgpu';
import {
  Fn,
  attribute,
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
import { FLOATS_PER_META, FLOATS_PER_POSE, packCrowdInputs, variationSeed, variationHash01, variationTint } from './packing';
import type { VisionCull } from './visionCull';
import { RiggedCrowd } from './rigged';
import {
  composeLimbMatrix,
  packLimbInputs,
  limbGait,
  FLOATS_PER_LIMB_POSE,
  FLOATS_PER_MAT4,
  type LimbPartPlacement,
  type LimbGait,
  type LimbGaitConfig,
} from './limbs';

/** Base crowd flesh/clothing tint; per-instance variation modulates its brightness in the shader (V2). */
const CROWD_BASE_COLOR = 0x4a5a3a;
/** Limbed-figure CLOTHING tint (torso/arms/legs) — a touch brighter than the horde box so hero/active figures read
 *  against the mass. Per-instance hue/value jitter varies it per zombie (T122/V87). */
const CROWD_LIMB_COLOR = 0x52613f;
/** Limbed-figure SKIN tint (head) — a warmer, paler decayed-flesh tone, distinct from the clothing (T122/V87). */
const CROWD_LIMB_SKIN_COLOR = 0x6e6a52;
/** Subtle per-instance HUE skew on the box horde colour, keyed by the variation seed (T122/V87). */
const CROWD_BOX_HUE_SPREAD = 0.14;
/** Salts decorrelating the per-slot hue vs value tint hashes (T122/V87). */
const TINT_HUE_SALT = 0x1111;
const TINT_VAL_SALT = 0x2222;
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
  /** Per-state limb gait tunables (swing/bob/reach/frequency by ZombieState + speed) (T111/V75). */
  readonly gait: LimbGaitConfig;
  /** Per-figure HUE jitter (+/-) on the limbed figures' part colours, keyed by a per-slot hash (T122/V87). */
  readonly limbTintHueSpread: number;
  /** Per-figure VALUE (brightness) jitter (+/-) on the limbed figures' part colours (T122/V87). */
  readonly limbTintValueSpread: number;
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
    // T111/V75 state-driven gait: walk swing/bob reuse the existing crowdLimbWalkSwingRadians/crowdLimbBobMeters;
    // idle/chase/attack + the per-state frequencies + the speed reference are their own tunables.
    gait: {
      idleSwingRadians: resolve(renderingConfig.crowdLimbIdleSwingRadians, tier),
      walkSwingRadians: resolve(renderingConfig.crowdLimbWalkSwingRadians, tier),
      chaseSwingRadians: resolve(renderingConfig.crowdLimbChaseSwingRadians, tier),
      idleFreqHz: resolve(renderingConfig.crowdLimbIdleFreqHz, tier),
      walkFreqHz: resolve(renderingConfig.crowdLimbWalkFreqHz, tier),
      chaseFreqHz: resolve(renderingConfig.crowdLimbChaseFreqHz, tier),
      idleBobMeters: resolve(renderingConfig.crowdLimbIdleBobMeters, tier),
      walkBobMeters: resolve(renderingConfig.crowdLimbBobMeters, tier),
      chaseBobMeters: resolve(renderingConfig.crowdLimbChaseBobMeters, tier),
      attackReachRadians: resolve(renderingConfig.crowdLimbAttackReachRadians, tier),
      chaseReachRadians: resolve(renderingConfig.crowdLimbChaseReachRadians, tier),
      attackFreqHz: resolve(renderingConfig.crowdLimbAttackFreqHz, tier),
      reachBlendHz: resolve(renderingConfig.crowdLimbReachBlendHz, tier),
      speedRefMetersPerSecond: resolve(renderingConfig.crowdLimbGaitSpeedRefMetersPerSecond, tier),
    },
    limbTintHueSpread: resolve(renderingConfig.crowdLimbTintHueSpread, tier),
    limbTintValueSpread: resolve(renderingConfig.crowdLimbTintValueSpread, tier),
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
  /** Per-state gait tunables (swing/bob/reach/frequency by ZombieState + speed) (T111/V75). */
  private readonly gait: LimbGaitConfig;
  private readonly variationCount: number;
  private readonly scaleMin: number;
  private readonly scaleMax: number;
  /** Per-figure tint jitter spreads (hue + value) for the per-instance colour variation (T122/V87). */
  private readonly tintHueSpread: number;
  private readonly tintValueSpread: number;
  /** Per-part base RGB (head = skin, body = clothing), tinted per-instance into the instTint attribute (T122/V87). */
  private readonly partBaseColor: Float32Array[];

  // Per-frame limbed inputs (compacted to the front) + scratch for instance-matrix composition.
  private readonly pose: Float32Array;
  private readonly scaleArr: Float32Array;
  /** Per-figure reveal alpha (V65) — copied into every part's instTint.w each frame so figures FADE (never shrink). */
  private readonly fadeArr: Float32Array;
  /** Per-part instanced tint+fade attribute (vec4 = [r,g,b, fade]); ONE vertex buffer carries colour AND alpha
   *  (T122/V87) — staying within the WebGPU 8-vertex-buffer limit (pos+normal+uv + instanceMatrix×4 + instTint). */
  private readonly tintAttrs: InstancedBufferAttribute[] = [];
  private readonly anatomy: Uint32Array;
  private readonly phase: Float32Array;
  /** Per-instance ZombieState + planar speed (T111/V75), compacted to the front by packLimbInputs. */
  private readonly stateArr: Uint8Array;
  private readonly speedArr: Float32Array;
  /** Per-instance SoA slot (T122/V87) — the stable identity hashed for per-instance tint. */
  private readonly slotArr: Float32Array;
  /** Per-instance gait swing/bob + eased forward reach for this frame (precomputed once per figure, reused
   *  across parts). reachArr is filled by packLimbInputs (per-slot eased arm-raise, T122/V87). */
  private readonly swingArr: Float32Array;
  private readonly bobArr: Float32Array;
  private readonly reachArr: Float32Array;
  /** Per-instance hue/value tint jitter ∈ [-1,1] (precomputed once per figure from its slot hash, T122/V87). */
  private readonly hueArr: Float32Array;
  private readonly valArr: Float32Array;
  private readonly gaitScratch: LimbGait = { swing: 0, bob: 0, reach: 0 };
  /** Per-SLOT gait phase accumulator (stable identity, seeded with per-slot offsets so figures are NOT in
   *  lockstep). The SoA animPhase is sim-owned + unadvanced, so the limb tier owns its phase here (V3). Lazily
   *  sized to the SoA slot count on first update. */
  private slotPhase: Float32Array | null = null;
  /** Per-SLOT eased forward arm-reach accumulator (T122/V87) — eased toward the per-state target so the chase/
   *  attack arm-raise blends in/out smoothly. Lazily sized to the SoA slot count alongside slotPhase. */
  private slotReach: Float32Array | null = null;
  private readonly matScratch = new Float32Array(FLOATS_PER_MAT4);
  private readonly posScratch = new Float32Array(3);
  private readonly mat4 = new Matrix4();

  constructor(settings: CrowdSettings, registry: ResourceRegistry, parent: Object3D) {
    this.budget = settings.limbedBudget;
    this.maxSimTier = settings.limbedMaxSimTier;
    this.gait = settings.gait;
    this.variationCount = settings.variationCount;
    this.scaleMin = settings.scaleMin;
    this.scaleMax = settings.scaleMax;
    this.tintHueSpread = settings.limbTintHueSpread;
    this.tintValueSpread = settings.limbTintValueSpread;

    // Per-part base colour: the head reads as SKIN, the body (torso/arms/legs) as CLOTHING; per-instance jitter
    // varies both per zombie (T122/V87).
    const skin = new Color(CROWD_LIMB_SKIN_COLOR);
    const cloth = new Color(CROWD_LIMB_COLOR);
    this.partBaseColor = CROWD_LIMB_PARTS.map((p) => {
      const c = p.id === 'head' ? skin : cloth;
      return new Float32Array([c.r, c.g, c.b]);
    });

    // One shared material family across all parts (no per-zombie/per-part material, V2).
    this.material = registry.track(
      new MeshStandardNodeMaterial({ color: CROWD_LIMB_COLOR, name: 'crowd.limb' }),
      'material',
      'crowd.limbMaterial',
    );

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
      // T122/V87: per-instance TINT + reveal ALPHA ride in ONE vec4 instanced attribute [r,g,b, fade]. Instead of
      // instanceColor (a separate binding) this keeps the limb within the WebGPU 8-vertex-buffer budget:
      // position+normal+uv + instanceMatrix×4 + instTint = 8. The shared material reads .xyz as colour + .w as
      // opacity (set below). Figures FADE via alpha (V65 — never scale/shrink) AND vary in colour per zombie.
      const tint = new Float32Array(this.budget * 4);
      for (let i = 0; i < this.budget; i++) tint[i * 4 + 3] = 1; // start fully visible
      const tintAttr = new InstancedBufferAttribute(tint, 4);
      tintAttr.setUsage(DynamicDrawUsage);
      geo.setAttribute('instTint', tintAttr);
      this.tintAttrs.push(tintAttr);
      registry.track(mesh, 'buffer', `crowd.limbMesh.${part.id}`);
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.meshes = meshes;
    this.material.transparent = true;
    // [r,g,b, fade] per instance in ONE vec4 attribute (T122/V87). Explicit 'vec4' type param so the swizzle
    // accessors (.xyz/.w) resolve (a bare string arg widens to `string` and drops the typed swizzles).
    const instTint = attribute<'vec4'>('instTint', 'vec4');
    this.material.colorNode = instTint.xyz; // per-instance skin/clothing tint (T122/V87)
    this.material.opacityNode = instTint.w; // per-instance reveal alpha (V65)
    this.placements = CROWD_LIMB_PARTS.map((p) => ({ offset: p.offset, pivotLen: p.pivotLen, swingSign: p.swingSign, reachSign: p.reachSign }));
    this.severBits = CROWD_LIMB_PARTS.map((p) => {
      const region = LIMB_REGION[p.id];
      return region ? regionBit(region) : 0;
    });

    this.pose = new Float32Array(this.budget * FLOATS_PER_LIMB_POSE);
    this.scaleArr = new Float32Array(this.budget);
    this.fadeArr = new Float32Array(this.budget).fill(1);
    this.anatomy = new Uint32Array(this.budget);
    this.phase = new Float32Array(this.budget);
    this.stateArr = new Uint8Array(this.budget);
    this.speedArr = new Float32Array(this.budget);
    this.slotArr = new Float32Array(this.budget);
    this.swingArr = new Float32Array(this.budget);
    this.bobArr = new Float32Array(this.budget);
    this.reachArr = new Float32Array(this.budget);
    this.hueArr = new Float32Array(this.budget);
    this.valArr = new Float32Array(this.budget);
  }

  /**
   * Compact the limbed-tier zombies and rebuild every part's instance matrices for this frame. Returns the
   * number of live limbed figures (also each part mesh's draw count). Severed parts get a zero (invisible)
   * matrix but keep their instance slot so indices stay aligned across parts. `dtSeconds` advances each
   * figure's gait phase at its per-state rate (T111/V75).
   */
  update(views: FieldViews, count: number, dtSeconds: number, visibility?: VisionCull): number {
    // Per-SLOT gait phase accumulator (T111/V75). Lazily allocated to the SoA slot count + seeded with a
    // per-slot offset so figures never march in lockstep (mirrors the box tier's per-instance phase seed).
    if (!this.slotPhase || this.slotPhase.length < count) {
      const next = new Float32Array(count);
      const denom = Math.max(1, this.variationCount);
      for (let slot = 0; slot < count; slot++) next[slot] = variationSeed(slot, denom) / denom;
      if (this.slotPhase) next.set(this.slotPhase.subarray(0, Math.min(this.slotPhase.length, count)));
      this.slotPhase = next;
    }
    // Per-SLOT eased arm-reach accumulator (T122/V87), sized alongside slotPhase; seeded 0 (arms down).
    if (!this.slotReach || this.slotReach.length < count) {
      const next = new Float32Array(count);
      if (this.slotReach) next.set(this.slotReach.subarray(0, Math.min(this.slotReach.length, count)));
      this.slotReach = next;
    }

    const { liveCount } = packLimbInputs(
      views,
      this.pose,
      this.scaleArr,
      this.anatomy,
      this.phase,
      this.stateArr,
      this.speedArr,
      this.slotPhase,
      this.slotReach,
      {
        count,
        capacity: this.budget,
        variationCount: this.variationCount,
        scaleMin: this.scaleMin,
        scaleMax: this.scaleMax,
        maxSimTier: this.maxSimTier,
        visibility,
        outFade: this.fadeArr,
        outReach: this.reachArr, // per-slot EASED forward arm-raise (T122/V87)
        outSlot: this.slotArr, // stable identity for the per-instance tint hash (T122/V87)
        dtSeconds,
        gait: this.gait,
      },
    );

    // Pre-pass: resolve each figure's state-driven swing/bob ONCE (reused across all 6 parts) + its stable tint
    // jitter. reachArr is already the eased forward arm-raise from packLimbInputs (T122/V87). Allocation-free.
    for (let i = 0; i < liveCount; i++) {
      const g = limbGait(this.gaitScratch, this.stateArr[i]!, this.speedArr[i]!, this.phase[i]!, this.gait);
      this.swingArr[i] = g.swing;
      this.bobArr[i] = g.bob;
      const slot = this.slotArr[i]!;
      this.hueArr[i] = variationHash01(slot, TINT_HUE_SALT) * 2 - 1;
      this.valArr[i] = variationHash01(slot, TINT_VAL_SALT) * 2 - 1;
    }

    for (let part = 0; part < this.meshes.length; part++) {
      const mesh = this.meshes[part]!;
      const placement = this.placements[part]!;
      const bit = this.severBits[part]!;
      const base = this.partBaseColor[part]!;
      const baseR = base[0]!;
      const baseG = base[1]!;
      const baseB = base[2]!;
      const tintArr = this.tintAttrs[part]!.array as Float32Array;
      for (let i = 0; i < liveCount; i++) {
        const p = i * FLOATS_PER_LIMB_POSE;
        this.posScratch[0] = this.pose[p]!;
        this.posScratch[1] = this.pose[p + 1]!;
        this.posScratch[2] = this.pose[p + 2]!;
        const heading = this.pose[p + 3]!;
        const visible = bit === 0 || (this.anatomy[i]! & bit) === 0;
        composeLimbMatrix(
          this.matScratch,
          0,
          this.posScratch,
          heading,
          this.scaleArr[i]!,
          placement,
          this.swingArr[i]!,
          this.reachArr[i]!,
          this.bobArr[i]!,
          visible,
        );
        this.mat4.fromArray(this.matScratch);
        mesh.setMatrixAt(i, this.mat4);
        // T122/V87: per-instance tint (skin/clothing base × stable hue/value jitter) + reveal alpha (V65) into vec4.
        const o = i * 4;
        variationTint(baseR, baseG, baseB, this.hueArr[i]!, this.valArr[i]!, this.tintHueSpread, this.tintValueSpread, tintArr, o);
        tintArr[o + 3] = this.fadeArr[i]!;
      }
      this.tintAttrs[part]!.needsUpdate = true;
      mesh.count = liveCount;
      mesh.instanceMatrix.needsUpdate = true;
    }
    return liveCount;
  }

  /** Hide every part (draw 0 instances) — used once the rigged crowd (T128) takes over the near band. */
  hide(): void {
    for (const mesh of this.meshes) mesh.count = 0;
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
  /**
   * RIGGED, animated near-band crowd (T128): one InstancedMesh per archetype, GPU-skinned from a baked bone
   * texture, parented UNDER `mesh` like the limbs. Until every archetype GLB has been baked + attached (async),
   * it draws nothing and the limbed figures own the near band; once ready it REPLACES them (limbs hidden). It
   * reuses the SAME packing partition + reveal fade + per-instance variation as the limbs it supersedes.
   */
  readonly rigged: RiggedCrowd;

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
    // RIGGED archetype crowd (T128): empty until the GLBs bake in via Crowd.rigged.attach; parented under the
    // box mesh (same wiring as the limbs). Once ready it takes over the near band; the limbs are the fallback.
    this.rigged = new RiggedCrowd(settings, this.mesh);

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

    // Per-instance colour variation from the meta storage buffer (seed -> brightness + subtle hue band). NO new
    // material. T122/V87: on top of the brightness band, a small warm↔cool HUE skew keyed by the same seed so the
    // far horde is not 100% uniform in hue either (the limbed figures get the richer skin/clothing tint).
    const base = new Color(CROWD_BASE_COLOR);
    const denom = Math.max(1, settings.variationCount - 1);
    const spread = settings.brightnessSpread;
    this.material.colorNode = Fn(() => {
      const seed = this.metaBuffer.toAttribute().y; // per-instance variation seed (vertex attr -> varying)
      const t = seed.div(denom); // 0..1 across the variation seeds
      const brightness = float(1 - spread).add(t.mul(spread * 2)); // [1-spread, 1+spread]
      const hue = t.sub(0.5).mul(CROWD_BOX_HUE_SPREAD); // subtle warm↔cool skew around the base
      const tint = vec3(float(1).add(hue), float(1), float(1).sub(hue));
      return vec3(base.r, base.g, base.b).mul(tint).mul(brightness);
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
    // Near band: the RIGGED archetype crowd draws it once every GLB has baked in (T128); until then the
    // procedural limbed figures own it (no visible gap). Both consume the same partition the box reserved, so
    // exactly one path draws each near member. The unused path is hidden (0 instances).
    if (this.rigged.isReady) {
      this.rigged.update(views, count, dtSeconds, visibility);
      this.limbs.hide();
    } else {
      this.limbs.update(views, count, dtSeconds, visibility);
      this.rigged.hide();
    }
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
