// T128 / V2 / V3 / V24 — RIGGED, ANIMATED crowd via INSTANCED GPU SKINNING off a baked BONE-MATRIX ANIMATION
// TEXTURE. The near band (hero + active-crowd tiers, the slots the procedural CrowdLimbs used to draw) is
// rendered as REAL rigged GLB meshes — ONE InstancedMesh per archetype, ONE draw call each. There is NO
// per-zombie object/mixer and NO per-frame CPU skinning (V2): at GLB load a render-side baker drives an
// AnimationMixer through each NEEDED clip, samples the 24 bone matrices at 30 fps, folds in the mesh's
// bind/scale/seat transforms, and writes them as a small RGBA-float DataTexture (rows = global frame index
// across clips, 4 texels = 4 columns per bone). A TSL `positionNode` then does standard linear-blend skinning
// per instance: it reads the instance's (clip row, world pose, scale) from instanced attributes, fetches the 4
// influencing bones' matrices for that frame via `textureLoad`, blends by skinWeight, then yaws/translates the
// skinned-local vertex into world. The per-frame CPU work is only the SoA→instance pack (pose/clip-row/fade),
// matching the existing crowd packing. Every GPU resource is registry-tracked for disposal (V24).
//
// Bind math (folded at bake so the shader stays a plain weighted sum): three skins as
//   worldLocal = meshWorld · bindInv · (Σ wᵢ boneMatrixᵢ) · bindMatrix · vertex
// and since meshWorld·bindInv and bindMatrix are constant, Σ wᵢ (A·boneMatrixᵢ·B) = A·(Σ wᵢ boneMatrixᵢ)·B, so
// each baked per-bone matrix is Mᵢ = T_seat · S_fit · meshWorld · bindInv · boneMatrixᵢ · bindMatrix and the
// shader just computes Σ wᵢ Mᵢ · vertex. T_seat/S_fit normalize the GLB to RIGGED_HEIGHT with feet at y=0.

import {
  AnimationMixer,
  Box3,
  Color,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
  Matrix4,
  NearestFilter,
  Quaternion,
  RGBAFormat,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type MeshStandardMaterial,
  type Object3D,
  type SkinnedMesh,
  type Texture,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  Fn,
  attribute,
  cos,
  float,
  int,
  ivec2,
  mat4,
  normalLocal,
  positionLocal,
  sin,
  texture,
  textureLoad,
  vec3,
  vec4,
} from 'three/tsl';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { FieldViews } from '../../game/core/contracts/soa';
import type { Corpse } from '../../game/zombie';
import type { Disposable, ResourceKind } from '../engine/resources';
import type { QualityTier } from '../../config/types';
import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import type { CrowdSettings } from './crowd';
import { BAND_RIGGED, variationHash01, variationScale, variationSeed } from './packing';
import { visionCullFade, type VisionCull } from './visionCull';
import type { CrowdImpostors } from './impostor';
import {
  Ragdoll,
  buildRagdollSpec,
  mulberry32,
  RAGDOLL_PARTICLE_BONES,
  RAGDOLL_PARTICLE_COUNT,
  RAGDOLL_BODIES,
  RAGDOLL_JOINTS,
  type RagdollConfig,
  type RagdollSpec,
  type RagdollBodyTopology,
  type RagdollColliders,
} from '../corpse/ragdoll';
import {
  ARCHETYPE_KEYS,
  CLIP_MAPS,
  advancePhase,
  archetypeKeyForIndex,
  bakeClipNames,
  buildClipTable,
  clipForState,
  clipPhaseRateHz,
  isFrozenIdle,
  isLocomotionState,
  locomotionRateHz,
  phaseToFrameRow,
  type ArchetypeKey,
  type ClipTable,
} from './riggedAnim';

/** Bake sampling rate — the recommended 30 fps (the bone texture stays small). */
const BAKE_FPS = 30;
/** 4 RGBA-float texels per bone = the 4 columns of the bone's affine mat4. */
const TEXELS_PER_BONE = 4;
/** Rigged crowd standing height (m) — matches the player avatar (T127) so scale reads consistently. The impostor
 *  lane fits its baked silhouette to the SAME height so the LOD swap reads at a consistent size (T140). */
export const RIGGED_HEIGHT_METERS = 1.8;
/** Fallback flesh tint if a GLB ships no albedo map (should not happen — Meshy bakes one into emissive). */
const RIGGED_FALLBACK_COLOR = 0x6e6a52;
/** T133 — per-instance render data is INTERLEAVED into ONE instanced vertex buffer (1 slot, 3 attributes) instead
 *  of 3 separate slots. three r184 cannot bind a storage buffer in the VERTEX stage (it mis-binds as a uniform —
 *  see `crowd.ts`), so per-instance data must be vertex attributes; interleaving keeps the rigged pass at 6/8
 *  vertex-buffer slots (5 mesh + 1 instance) with headroom for normal-map tangents / future per-instance effect
 *  channels (damage flash, wetness, bloodiness pack into the spare iBlend.zw, NOT a new slot). Layout (floats):
 *  [0..3] iPose [px,py,pz,heading] · [4..7] iAnim [frameRow,scale,fade,seed] · [8..11] iBlend [fromRow,weight,_,_]. */
const FLOATS_PER_INSTANCE = 12;
const INST_POSE = 0;
const INST_ANIM = 4;
const INST_BLEND = 8;
/** Corpse per-instance interleave (1 slot, 2 attributes): [0..3] iPose · [4..7] iCorpse [scale,pitch,fallYaw,seed]. */
const FLOATS_PER_CORPSE_INSTANCE = 8;
const CORPSE_INST_POSE = 0;
const CORPSE_INST_ANIM = 4;
/** T132 — state crossfade duration (s): on a clip change the body blends from a frozen FROM-pose to the new clip
 *  over this window instead of popping. Short (a snappy transition reads as reactive, not floaty). */
const STATE_BLEND_SECONDS = 0.18;
/** Per-instance gait-cadence jitter (±fraction) so members don't all stride in identical-rate lockstep (T128). */
const CADENCE_JITTER_SPREAD = 0.14;
/** Salt for the per-slot cadence-jitter hash (decorrelated from the colour/scale variation channels). */
const CADENCE_SALT = 0x5cad;
/** T131/V99 — CORPSE layer: a dead body keeps its archetype's rigged mesh but FROZEN at this clip's frame 0 (a
 *  neutral standing pose); the impact-directional topple then tips it prone. Reusing the bake means a corpse reads
 *  as the SAME zombie that was walking, not a blob. */
const CORPSE_FROZEN_CLIP = 'idle' as const;
/** Dead flesh reads slightly darker / drained vs the live crowd — a subtle multiply on the shared albedo (still
 *  clearly the same mesh, scene-lit, NOT a recoloured prop). */
const CORPSE_DARKEN = 0.78;
/** Salt for the per-corpse variation seed (stable per dead entity, deterministic V26 — not the live slot channel). */
const CORPSE_SEED_SALT = 0x6c07;
/** Salt for the per-corpse RAGDOLL impulse-jitter PRNG (T134 — decorrelated from the colour/scale seed channel). */
const RAGDOLL_SEED_SALT = 0x9e37;

/** Registry track signature handed in from BlockScene (V24). */
export type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;

/** Resolve the per-limb death-ragdoll tunables for a tier (V4 — every constant the sim reads is typed config). */
export function resolveRagdollConfig(tier: QualityTier): RagdollConfig {
  return {
    gravity: resolve(renderingConfig.ragdollGravityMetersPerSec2, tier),
    linearDamping: resolve(renderingConfig.ragdollLinearDamping, tier),
    internalLinearDamping: resolve(renderingConfig.ragdollInternalLinearDamping, tier),
    angularDamping: resolve(renderingConfig.ragdollAngularDamping, tier),
    tumbleDamping: resolve(renderingConfig.ragdollTumbleDamping, tier),
    jointAngularDamping: resolve(renderingConfig.ragdollJointAngularDamping, tier),
    groundAngularDamping: resolve(renderingConfig.ragdollGroundAngularDamping, tier),
    groundRestitution: resolve(renderingConfig.ragdollGroundRestitution, tier),
    groundFriction: resolve(renderingConfig.ragdollGroundFriction, tier),
    constraintIterations: resolve(renderingConfig.ragdollConstraintIterations, tier),
    substeps: resolve(renderingConfig.ragdollSubsteps, tier),
    impulseScale: resolve(renderingConfig.ragdollImpulseScale, tier),
    torqueScale: resolve(renderingConfig.ragdollTorqueScale, tier),
    settleEnergyThreshold: resolve(renderingConfig.ragdollSettleEnergyThreshold, tier),
    settleSpeed: resolve(renderingConfig.ragdollSettleSpeed, tier),
    torsoRadius: resolve(renderingConfig.ragdollTorsoRadiusMeters, tier),
    headRadius: resolve(renderingConfig.ragdollHeadRadiusMeters, tier),
    limbRadius: resolve(renderingConfig.ragdollLimbRadiusMeters, tier),
    spineLimit: resolve(renderingConfig.ragdollSpineLimitRadians, tier),
    neckLimit: resolve(renderingConfig.ragdollNeckLimitRadians, tier),
    shoulderLimit: resolve(renderingConfig.ragdollShoulderLimitRadians, tier),
    hipLimit: resolve(renderingConfig.ragdollHipLimitRadians, tier),
    hingeSwingLimit: resolve(renderingConfig.ragdollHingeSwingLimitRadians, tier),
    elbowMax: resolve(renderingConfig.ragdollElbowMaxRadians, tier),
    kneeMax: resolve(renderingConfig.ragdollKneeMaxRadians, tier),
    trunkStiffness: resolve(renderingConfig.ragdollTrunkStiffness, tier),
    trunkIterations: resolve(renderingConfig.ragdollTrunkIterations, tier),
    maxLinearSpeed: resolve(renderingConfig.ragdollMaxLinearSpeed, tier),
    maxAngularSpeed: resolve(renderingConfig.ragdollMaxAngularSpeed, tier),
    explodeSpeed: resolve(renderingConfig.ragdollExplodeSpeed, tier),
    colliderGatherRadius: resolve(renderingConfig.ragdollColliderGatherRadiusMeters, tier),
  };
}

/**
 * T134 STATIC WORLD COLLISION — a source of WORLD-space static colliders near a point, supplied by the scene so a
 * launched corpse collides against the SAME walls/obstacles agents do. Called ONCE per corpse at spawn with the
 * death spot + gather radius; returns wall `segments` ([x1,z1,x2,z2,…]) + round-obstacle `circles` ([cx,cz,r,…]) in
 * WORLD meters. The rigged crowd transforms them into the corpse-local frame before handing them to the ragdoll.
 */
export type WorldColliderSource = (worldX: number, worldZ: number, radius: number) => {
  readonly segments: Float32Array;
  readonly circles: Float32Array;
};

function requireView<T>(views: FieldViews, name: string): T {
  const v = views[name];
  if (!v) throw new Error(`SoA view '${name}' missing — rigged crowd requires the frozen ZOMBIE_FIELDS layout`);
  return v as unknown as T;
}

/** One attached archetype: its rigged InstancedMesh + the per-frame instance buffers it packs into. */
interface ArchetypeSlot {
  readonly key: ArchetypeKey;
  readonly mesh: InstancedMesh;
  readonly table: ClipTable;
  /** Per-clip ground stride (m) captured at bake — paces playback to the member's speed (T128). */
  readonly strideByName: ReadonlyMap<string, number>;
  /** T133 — INTERLEAVED per-instance data (one vertex-buffer slot, 3 attributes): iPose@0, iAnim@4, iBlend@8.
   *  iPose [px,py,pz,heading] · iAnim [frameRow,scale,revealAlpha,seed] · iBlend [fromFrameRow,targetWeight,_,_]
   *  (T132 crossfade — shader skins the TARGET clip + a frozen FROM-pose, mixes by targetWeight). */
  readonly instArr: Float32Array;
  readonly instBuf: InstancedInterleavedBuffer;
  live: number;
  // ---- T131/V99 CORPSE layer: a SECOND InstancedMesh per archetype, reusing this bake (bone texture + albedo +
  // skinning), drawn from the corpse POOL (frozen frame + impact topple). Separate geometry/attrs so it never
  // double-draws the live crowd. ----
  readonly corpseMesh: InstancedMesh;
  /** T133/T134 — INTERLEAVED per-corpse data (one slot, 2 attributes): iPose@0 [px,py,pz,heading] · iCorpse@4
   *  [scale, liveBoneRow, 0, variationSeed]. `liveBoneRow` indexes this archetype's LIVE per-corpse bone texture. */
  readonly corpseArr: Float32Array;
  readonly corpseBuf: InstancedInterleavedBuffer;
  corpseLive: number;
  // ---- T134 RAGDOLL: per-archetype immutable ragdoll definition + a LIVE per-corpse bone-matrix texture the
  // corpse shader skins from (rows = corpse slots, cols = boneCount×4 texels = the 4 mat4 columns). The ragdoll
  // sim writes each live corpse's 24 bone matrices into its row every frame (replacing the rigid whole-body topple). ----
  readonly ragSpec: RagdollSpec;
  readonly boneCount: number;
  readonly liveBoneTex: DataTexture;
  readonly liveBoneData: Float32Array;
}

/**
 * Bake one archetype GLB to a bone-matrix animation texture + build its rigged InstancedMesh + shared skinning
 * material. GPU-device-free (AnimationMixer + Skeleton.update are CPU); only the texture/buffer UPLOAD needs the
 * device, on first render. Returns everything the RiggedCrowd needs to pack + draw that archetype.
 */
function buildArchetype(key: ArchetypeKey, gltf: GLTF, budget: number, corpseCapacity: number, settings: CrowdSettings, ragdollConfig: RagdollConfig, track: TrackFn): ArchetypeSlot {
  gltf.scene.updateMatrixWorld(true);

  let skinned: SkinnedMesh | null = null;
  gltf.scene.traverse((o) => {
    const m = o as SkinnedMesh;
    if (m.isSkinnedMesh && !skinned) skinned = m;
  });
  if (!skinned) throw new Error(`zombie GLB '${key}' has no SkinnedMesh`);
  const mesh = skinned as SkinnedMesh;

  const geometry = mesh.geometry as BufferGeometry;
  const skeleton = mesh.skeleton;
  const boneCount = skeleton.bones.length;
  if (!geometry.getAttribute('skinIndex') || !geometry.getAttribute('skinWeight')) {
    throw new Error(`zombie GLB '${key}' geometry lacks skinIndex/skinWeight`);
  }

  // ---- Material ROOT-FIX (mirrors the player avatar, T127/V93): Meshy bakes the ALBEDO into the EMISSIVE
  // channel + leaves metalness 1 → full-bright/self-lit. Use the baked map as the LIT albedo + a dielectric. ----
  const srcMat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial;
  const albedo = (srcMat.emissiveMap ?? srcMat.map) as Texture | null;
  if (albedo) albedo.colorSpace = SRGBColorSpace;

  // ---- Fit + seat: normalize the bind-pose GLB to RIGGED_HEIGHT with feet at y=0 (folded into every Mᵢ). ----
  const box = new Box3().setFromObject(gltf.scene);
  const size = box.getSize(new Vector3());
  const fit = size.y > 0 ? RIGGED_HEIGHT_METERS / size.y : 1;
  // F = the GEOMETRIC fit-to-output transform (no bind sandwich): maps a GLB-scene point to the output-local
  // space the corpse renders in (meters, feet at y=0). T134 uses it to seed the ragdoll joint particles where the
  // bones visually are at the frozen idle pose. leftConst = F · bindMatrixInverse (the skinning fold).
  const fitWorld = new Matrix4()
    .makeTranslation(0, -box.min.y * fit, 0)
    .multiply(new Matrix4().makeScale(fit, fit, fit))
    .multiply(mesh.matrixWorld);
  const leftConst = new Matrix4().copy(fitWorld).multiply(mesh.bindMatrixInverse);
  const bindMatrix = mesh.bindMatrix;

  // T134/V2 — seed-pose capture: the LIVE corpse ragdoll (oriented rigid bodies) starts from the FROZEN idle
  // pose. At idle frame 0 we capture (a) each ragdoll JOINT-PARTICLE output-local position (seeds the capsule ends
  // + joint anchors), and (b) each rigid BODY's REST TRANSFORM = its anchor bone's output-local world matrix
  // (`fitWorld · bone.matrixWorld`, decomposed to rigid pos+quat — scale dropped, it lives in M0). Both are filled
  // in the bake loop below. Plus the bone name→index map for the body→bone resolve.
  const boneByName = new Map<string, number>();
  for (let b = 0; b < boneCount; b++) boneByName.set(skeleton.bones[b]!.name, b);
  const ragSeed = new Float32Array(RAGDOLL_PARTICLE_COUNT * 3);
  const bodyRestPos = new Float32Array(RAGDOLL_BODIES.length * 3);
  const bodyRestQuat = new Float32Array(RAGDOLL_BODIES.length * 4);
  const frozenClipName = CLIP_MAPS[key][CORPSE_FROZEN_CLIP];
  const _seedPos = new Vector3();
  const _restMat = new Matrix4();
  const _restPos = new Vector3();
  const _restQuat = new Quaternion();
  const _restScale = new Vector3();

  // ---- Bake every needed clip at BAKE_FPS into the bone texture (rows = global frame index across clips). ----
  const clipNames = bakeClipNames(key);
  const clipByName = new Map(gltf.animations.map((c) => [c.name, c]));
  const specs = clipNames.map((name) => {
    const clip = clipByName.get(name);
    if (!clip) throw new Error(`zombie '${key}' GLB missing clip '${name}'`);
    return { name, frameCount: Math.max(1, Math.round(clip.duration * BAKE_FPS)) };
  });
  const table = buildClipTable(specs, BAKE_FPS);

  const width = boneCount * TEXELS_PER_BONE;
  const data = new Float32Array(width * table.totalRows * 4);
  const mixer = new AnimationMixer(gltf.scene);
  const M = new Matrix4();
  const boneMat = new Matrix4();

  // ROOT-MOTION REMOVAL: the locomotion clips translate the root bone FORWARD (root motion). The SoA drives a
  // member's actual world position, so a baked forward translation makes the rigged figure SLIDE then snap each
  // loop ("a segment replaying" rather than running in place). We pin the root bone's HORIZONTAL (XZ) world
  // position to its bind pose every frame — leg/arm bones still cycle relative to the root, so the clip reads as
  // an IN-PLACE gait. Captured at the bind pose (no clip applied yet). Vertical bob is kept.
  const rootBone = skeleton.bones[0];
  const rootBind = new Vector3();
  if (rootBone) rootBind.setFromMatrixPosition(rootBone.matrixWorld);
  const rootNow = new Vector3();
  const rootPrev = new Vector3();
  const rootFirst = new Vector3();
  const leftConstFrame = new Matrix4();

  // Per-clip ground STRIDE (m, fitted): the path length the root travels over one cycle. Used to pace playback
  // to the member's actual speed so the feet match the ground (T128). 0 for a stationary/in-place clip.
  const strideByName = new Map<string, number>();

  for (const name of clipNames) {
    const clip = clipByName.get(name)!;
    const entry = table.entries.get(name)!;
    mixer.stopAllAction();
    const action = mixer.clipAction(clip);
    action.reset();
    action.play();
    let stride = 0;
    for (let f = 0; f < entry.frameCount; f++) {
      mixer.setTime(f / BAKE_FPS); // resets all action times to 0 then advances by t (only this action plays)
      gltf.scene.updateMatrixWorld(true);
      skeleton.update(); // boneMatrices[b] = bone.matrixWorld · boneInverse
      const boneMatrices = skeleton.boneMatrices;
      if (!boneMatrices) throw new Error(`zombie '${key}' skeleton has no boneMatrices after update`);
      // Cancel the frame's horizontal root drift (in OUTPUT space → scaled by `fit`), prepended to leftConst,
      // AND accumulate the root's ground path length (= the clip stride) before cancelling it.
      if (rootBone) {
        rootNow.setFromMatrixPosition(rootBone.matrixWorld);
        if (f === 0) rootFirst.copy(rootNow);
        else stride += Math.hypot(rootNow.x - rootPrev.x, rootNow.z - rootPrev.z) * fit;
        rootPrev.copy(rootNow);
        leftConstFrame.makeTranslation(-(rootNow.x - rootBind.x) * fit, 0, -(rootNow.z - rootBind.z) * fit).multiply(leftConst);
      } else {
        leftConstFrame.copy(leftConst);
      }
      const rowBase = (entry.startRow + f) * width * 4;
      for (let b = 0; b < boneCount; b++) {
        boneMat.fromArray(boneMatrices, b * 16);
        M.copy(leftConstFrame).multiply(boneMat).multiply(bindMatrix);
        data.set(M.elements, rowBase + b * TEXELS_PER_BONE * 4); // 16 floats = 4 RGBA texels = 4 columns
      }
      // T134/V2 — capture the ragdoll's SEED joint positions + per-body REST TRANSFORMS at frozen idle frame 0
      // (output-local = fitWorld · boneWorld).
      if (name === frozenClipName && f === 0) {
        // NB: the bone `matrixWorld` is ALREADY in output-local meters (feet ≈ y=0, ~RIGGED_HEIGHT tall) — the
        // GLB's armature is in metres while its GEOMETRY is in large units, so `fitWorld` (which seats + scales the
        // GEOMETRY into output space for M0) must NOT be applied here, or it collapses every bone to the origin.
        for (let p = 0; p < RAGDOLL_PARTICLE_COUNT; p++) {
          const bi = boneByName.get(RAGDOLL_PARTICLE_BONES[p]!);
          if (bi === undefined) throw new Error(`rigged '${key}' missing ragdoll bone '${RAGDOLL_PARTICLE_BONES[p]}'`);
          _seedPos.setFromMatrixPosition(skeleton.bones[bi]!.matrixWorld);
          ragSeed[p * 3] = _seedPos.x;
          ragSeed[p * 3 + 1] = _seedPos.y;
          ragSeed[p * 3 + 2] = _seedPos.z;
        }
        for (let bd = 0; bd < RAGDOLL_BODIES.length; bd++) {
          const anchorName = RAGDOLL_BODIES[bd]!.anchorBone;
          const bi = boneByName.get(anchorName);
          if (bi === undefined) throw new Error(`rigged '${key}' missing ragdoll body anchor bone '${anchorName}'`);
          _restMat.copy(skeleton.bones[bi]!.matrixWorld);
          _restMat.decompose(_restPos, _restQuat, _restScale); // drop scale — it lives in M0
          bodyRestPos[bd * 3] = _restPos.x;
          bodyRestPos[bd * 3 + 1] = _restPos.y;
          bodyRestPos[bd * 3 + 2] = _restPos.z;
          bodyRestQuat[bd * 4] = _restQuat.x;
          bodyRestQuat[bd * 4 + 1] = _restQuat.y;
          bodyRestQuat[bd * 4 + 2] = _restQuat.z;
          bodyRestQuat[bd * 4 + 3] = _restQuat.w;
        }
      }
    }
    // Close the cycle (last frame → first) so a looping stride counts its full ground distance.
    if (rootBone && entry.frameCount > 1) stride += Math.hypot(rootFirst.x - rootPrev.x, rootFirst.z - rootPrev.z) * fit;
    strideByName.set(name, stride);
  }
  mixer.stopAllAction();

  const boneTex = new DataTexture(data, width, table.totalRows, RGBAFormat, FloatType);
  boneTex.magFilter = NearestFilter;
  boneTex.minFilter = NearestFilter;
  boneTex.generateMipmaps = false;
  boneTex.flipY = false;
  boneTex.name = `crowd.rigged.${key}.bones`;
  boneTex.needsUpdate = true;
  track(boneTex, 'texture', `crowd.rigged.${key}.boneTex`);
  track(geometry as unknown as Disposable, 'geometry', `crowd.rigged.${key}.geo`);
  if (albedo) track(albedo as unknown as Disposable, 'texture', `crowd.rigged.${key}.albedo`);

  // ---- Shared skinning material (one per archetype, never per-zombie, V2). ----
  const material = new MeshStandardNodeMaterial({ name: `crowd.rigged.${key}` });
  material.metalness = 0; // a corpse is not metal — Meshy left the glTF default 1, which kills diffuse lighting
  material.roughness = 0.85;
  material.transparent = true; // reveal fade rides in opacity (V65) — solids still occlude (depthWrite default)

  const denom = Math.max(1, settings.variationCount - 1);
  const spread = settings.brightnessSpread;
  const halfPi = Math.PI / 2;

  // GPU instanced skinning: read the per-frame bone matrices for this instance's clip row, blend by weight,
  // then yaw + scale + translate the skinned vertex into world. Mirrors three's SkinningNode math, but the
  // bind/scale/seat are folded into the texture so the shader is a plain weighted sum.
  material.positionNode = Fn(() => {
    const skinIndex = attribute<'uvec4'>('skinIndex', 'uvec4');
    const skinWeight = attribute<'vec4'>('skinWeight', 'vec4');
    const pose = attribute<'vec4'>('iPose', 'vec4'); // [posX, posY, posZ, heading]
    const anim = attribute<'vec4'>('iAnim', 'vec4'); // [frameRow, scale, fade, seed]
    const blend = attribute<'vec4'>('iBlend', 'vec4'); // [fromFrameRow, targetWeight, 0, 0] — T132 crossfade

    // Standard linear-blend skinning at a given bone-texture ROW (the 4 influencing bones, weighted). Returns the
    // skinned local POSITION + NORMAL. Called for the TARGET clip row and the frozen FROM-pose row, then mixed.
    const p4 = vec4(positionLocal, 1.0);
    const n4 = vec4(normalLocal, 0.0); // w=0 → each bone's 3×3 rotation applies to the normal (no translation)
    const skinAt = (row: ReturnType<typeof int>) => {
      const boneColumns = (boneIdx: ReturnType<typeof int>) => {
        const c = boneIdx.mul(TEXELS_PER_BONE);
        return mat4(
          textureLoad(boneTex, ivec2(c, row)),
          textureLoad(boneTex, ivec2(c.add(1), row)),
          textureLoad(boneTex, ivec2(c.add(2), row)),
          textureLoad(boneTex, ivec2(c.add(3), row)),
        );
      };
      const m0 = boneColumns(int(skinIndex.x));
      const m1 = boneColumns(int(skinIndex.y));
      const m2 = boneColumns(int(skinIndex.z));
      const m3 = boneColumns(int(skinIndex.w));
      const pos = m0
        .mul(p4)
        .mul(skinWeight.x)
        .add(m1.mul(p4).mul(skinWeight.y))
        .add(m2.mul(p4).mul(skinWeight.z))
        .add(m3.mul(p4).mul(skinWeight.w)).xyz;
      const nrm = m0
        .mul(n4)
        .xyz.mul(skinWeight.x)
        .add(m1.mul(n4).xyz.mul(skinWeight.y))
        .add(m2.mul(n4).xyz.mul(skinWeight.z))
        .add(m3.mul(n4).xyz.mul(skinWeight.w));
      return { pos, nrm };
    };

    // T132 STATE CROSSFADE: skin the target clip + the frozen from-pose, then lerp by the target weight (w=1 →
    // fully target, so a non-transitioning member pays only the lerp, visually unchanged). Killing the pose POP
    // when a member switches idle↔walk↔run↔attack. mix(b, a, w) = b + (a−b)·w.
    const w = blend.y;
    const a = skinAt(int(anim.x));
    const b = skinAt(int(blend.x));
    const local = b.pos.add(a.pos.sub(b.pos).mul(w));
    const n = b.nrm.add(a.nrm.sub(b.nrm).mul(w));

    // Instance transform — SAME facing convention as the box/limb crowd: yaw maps the rig's local +Z forward to
    // the SoA heading, i.e. facing = heading - 90° (atan2(dirZ,dirX)); uniform per-instance scale; translate to pose.
    const scale = anim.y;
    const facing = pose.w.sub(halfPi);
    const c = cos(facing);
    const s = sin(facing);
    const sx = local.x.mul(scale);
    const sy = local.y.mul(scale);
    const sz = local.z.mul(scale);
    const wx = c.mul(sx).sub(s.mul(sz)).add(pose.x);
    const wy = sy.add(pose.y);
    const wz = s.mul(sx).add(c.mul(sz)).add(pose.z);

    const nx = c.mul(n.x).sub(s.mul(n.z));
    const nz = s.mul(n.x).add(c.mul(n.z));
    normalLocal.assign(vec3(nx, n.y, nz).normalize());

    return vec3(wx, wy, wz);
  })();

  // Per-instance colour: the LIT albedo map (Meshy emissive→albedo) × a subtle per-seed brightness band (V2/T122).
  const baseTint = new Color(RIGGED_FALLBACK_COLOR);
  material.colorNode = Fn(() => {
    const seed = attribute<'vec4'>('iAnim', 'vec4').w;
    const t = seed.div(denom);
    const brightness = float(1 - spread).add(t.mul(spread * 2));
    const base = albedo ? texture(albedo).rgb : vec3(baseTint.r, baseTint.g, baseTint.b);
    return base.mul(brightness);
  })();
  // Reveal fade = ALPHA (V65) — a member entering/leaving awareness blends instead of popping (rides iAnim.z).
  material.opacityNode = attribute<'vec4'>('iAnim', 'vec4').z;
  track(material as unknown as Disposable, 'material', `crowd.rigged.${key}.mat`);

  // T133 — all per-instance data INTERLEAVED into ONE instanced vertex buffer (1 slot, 3 attributes): the mesh
  // already uses 5 vertex buffers (position+normal+uv+skinIndex+skinWeight), so this lands at 6/8 with headroom.
  // (Storage buffers are not vertex-stage bindable on three r184, so per-instance data has to be attributes.)
  const instArr = new Float32Array(budget * FLOATS_PER_INSTANCE);
  const instBuf = new InstancedInterleavedBuffer(instArr, FLOATS_PER_INSTANCE);
  instBuf.setUsage(DynamicDrawUsage);
  geometry.setAttribute('iPose', new InterleavedBufferAttribute(instBuf, 4, INST_POSE));
  geometry.setAttribute('iAnim', new InterleavedBufferAttribute(instBuf, 4, INST_ANIM));
  geometry.setAttribute('iBlend', new InterleavedBufferAttribute(instBuf, 4, INST_BLEND));

  const inst = new InstancedMesh(geometry, material, budget);
  inst.count = 0;
  inst.frustumCulled = false; // a rigged crowd spans large bounds; cluster-cull later (T30)
  inst.castShadow = true;
  inst.receiveShadow = true;
  inst.name = `crowd.rigged.${key}`;
  track(inst as unknown as Disposable, 'buffer', `crowd.rigged.${key}.mesh`);

  // ---- T134 RAGDOLL: build the per-archetype ragdoll spec from the captured seed pose + the baked FROZEN idle
  // bone matrices (M0, read straight out of `data` so the rest pose is EXACTLY the old frozen corpse pose), and a
  // LIVE per-corpse bone-matrix texture the corpse shader skins from. ----
  const frozenRow = table.entries.get(frozenClipName)!.startRow;
  const m0 = data.slice(frozenRow * width * 4, frozenRow * width * 4 + boneCount * 16); // one row = 24 bones × 16
  // V2 — resolve each rigid body's carried bone NAMES → skeleton indices + attach its captured rest transform.
  const bodies: RagdollBodyTopology[] = RAGDOLL_BODIES.map((bd, i) => ({
    bones: bd.bones.map((bn) => {
      const bi = boneByName.get(bn);
      if (bi === undefined) throw new Error(`rigged '${key}' ragdoll body missing bone '${bn}'`);
      return bi;
    }),
    capStart: bd.capStart,
    capEnd: bd.capEnd,
    sizeClass: bd.sizeClass,
    restPos: [bodyRestPos[i * 3]!, bodyRestPos[i * 3 + 1]!, bodyRestPos[i * 3 + 2]!] as const,
    restQuat: [bodyRestQuat[i * 4]!, bodyRestQuat[i * 4 + 1]!, bodyRestQuat[i * 4 + 2]!, bodyRestQuat[i * 4 + 3]!] as const,
  }));
  const ragSpec = buildRagdollSpec(
    { boneCount, seed: ragSeed, m0, bodies, joints: RAGDOLL_JOINTS },
    ragdollConfig,
  );

  // LIVE per-corpse bone texture: rows = corpse slots, cols = boneCount×4 texels (the 4 mat4 columns), RGBA float.
  // Seeded to the frozen idle pose (M0 repeated per row) so a corpse drawn before its first ragdoll step still
  // reads as the standing zombie. Re-uploaded each frame (the ragdoll writes each live corpse's row). V24-tracked.
  const liveWidth = boneCount * TEXELS_PER_BONE;
  const cap = Math.max(1, corpseCapacity);
  const liveBoneData = new Float32Array(liveWidth * cap * 4);
  for (let row = 0; row < cap; row++) liveBoneData.set(m0, row * boneCount * 16);
  const liveBoneTex = new DataTexture(liveBoneData, liveWidth, cap, RGBAFormat, FloatType);
  liveBoneTex.magFilter = NearestFilter;
  liveBoneTex.minFilter = NearestFilter;
  liveBoneTex.generateMipmaps = false;
  liveBoneTex.flipY = false;
  liveBoneTex.name = `corpse.rigged.${key}.liveBones`;
  liveBoneTex.needsUpdate = true;
  track(liveBoneTex, 'texture', `corpse.rigged.${key}.liveBoneTex`);

  // ---- T134 CORPSE layer: the SAME rigged mesh, skinned from the LIVE per-corpse ragdoll texture (no whole-body
  // topple). A CLONED geometry carries its own per-corpse instance attributes so the corpse pool never double-draws
  // the live crowd. The per-corpse `liveBoneRow` attribute (iCorpse.y) selects the corpse's row in the live texture. ----
  const corpseSlot = buildCorpseLayer(key, geometry, liveBoneTex, albedo, corpseCapacity, denom, spread, track);

  return {
    key,
    mesh: inst,
    table,
    strideByName,
    instArr,
    instBuf,
    live: 0,
    ragSpec,
    boneCount,
    liveBoneTex,
    liveBoneData,
    ...corpseSlot,
  };
}

/**
 * T134 — build one archetype's CORPSE InstancedMesh: a per-limb RAGDOLL body skinned from a LIVE per-corpse
 * bone-matrix texture (`liveBoneTex`), reusing the live crowd's `albedo` (same zombie, scene-lit), on a CLONED
 * geometry that SHARES the vertex data (position/normal/uv/skinIndex/skinWeight) but carries its OWN per-corpse
 * instance attributes — so the corpse pool draws independently of the live crowd (no double-draw). The skinning
 * mirrors the live `positionNode` (the `skinAt` weighted sum of 4 bones) but reads `textureLoad` from the LIVE
 * texture at the corpse's ROW (iCorpse.y) instead of the baked clip texture, and applies NO whole-body topple — the
 * ragdoll already places the bones in output-local space; the shader only re-applies the per-instance facing yaw +
 * scale + world translate (exactly as the live crowd does). Per-corpse data is INTERLEAVED into one instanced buffer
 * (T133), so this is 6/8 vertex-buffer slots (5 mesh + 1 instance). Every GPU resource is registry-tracked (V24).
 */
type CorpseLayer = Pick<ArchetypeSlot, 'corpseMesh' | 'corpseArr' | 'corpseBuf' | 'corpseLive'>;

function buildCorpseLayer(
  key: ArchetypeKey,
  liveGeo: BufferGeometry,
  liveBoneTex: Texture,
  albedo: Texture | null,
  capacity: number,
  denom: number,
  spread: number,
  track: TrackFn,
): CorpseLayer {
  const cap = Math.max(1, capacity);

  // CLONE the geometry (own GPU buffers → safe independent disposal) then strip the live instanced attributes and
  // install the corpse's own pose + ragdoll-row attributes. The base vertex attributes (position/normal/uv/skin*)
  // ride along the clone, so the corpse renders the identical mesh.
  const geo = liveGeo.clone();
  if (geo.getAttribute('iPose')) geo.deleteAttribute('iPose');
  if (geo.getAttribute('iAnim')) geo.deleteAttribute('iAnim');
  if (geo.getAttribute('iBlend')) geo.deleteAttribute('iBlend'); // T132 live-only attr — corpse pose is ragdoll-driven
  // T133 — interleave the corpse's pose + ragdoll-row into ONE instanced buffer (iPose@0, iCorpse@4): 1 slot, 2 attrs.
  const corpseArr = new Float32Array(cap * FLOATS_PER_CORPSE_INSTANCE);
  const corpseBuf = new InstancedInterleavedBuffer(corpseArr, FLOATS_PER_CORPSE_INSTANCE);
  corpseBuf.setUsage(DynamicDrawUsage);
  geo.setAttribute('iPose', new InterleavedBufferAttribute(corpseBuf, 4, CORPSE_INST_POSE));
  geo.setAttribute('iCorpse', new InterleavedBufferAttribute(corpseBuf, 4, CORPSE_INST_ANIM));
  track(geo as unknown as Disposable, 'geometry', `corpse.rigged.${key}.geo`);

  const material = new MeshStandardNodeMaterial({ name: `corpse.rigged.${key}` });
  material.metalness = 0;
  material.roughness = 0.92; // a settled body is matte
  const halfPi = Math.PI / 2; // the standing→facing yaw offset (SAME convention as the live crowd)

  material.positionNode = Fn(() => {
    const skinIndex = attribute<'uvec4'>('skinIndex', 'uvec4');
    const skinWeight = attribute<'vec4'>('skinWeight', 'vec4');
    const pose = attribute<'vec4'>('iPose', 'vec4'); // [posX, posY, posZ, heading]
    const corpse = attribute<'vec4'>('iCorpse', 'vec4'); // [scale, liveBoneRow, 0, seed]
    const row = int(corpse.y); // this corpse's ROW in the LIVE per-corpse ragdoll bone texture

    const boneColumns = (boneIdx: ReturnType<typeof int>) => {
      const c = boneIdx.mul(TEXELS_PER_BONE);
      return mat4(
        textureLoad(liveBoneTex, ivec2(c, row)),
        textureLoad(liveBoneTex, ivec2(c.add(1), row)),
        textureLoad(liveBoneTex, ivec2(c.add(2), row)),
        textureLoad(liveBoneTex, ivec2(c.add(3), row)),
      );
    };
    const m0 = boneColumns(int(skinIndex.x));
    const m1 = boneColumns(int(skinIndex.y));
    const m2 = boneColumns(int(skinIndex.z));
    const m3 = boneColumns(int(skinIndex.w));

    const p4 = vec4(positionLocal, 1.0);
    const local = m0
      .mul(p4)
      .mul(skinWeight.x)
      .add(m1.mul(p4).mul(skinWeight.y))
      .add(m2.mul(p4).mul(skinWeight.z))
      .add(m3.mul(p4).mul(skinWeight.w)).xyz;
    const n4 = vec4(normalLocal, 0.0);
    const nrm = m0
      .mul(n4)
      .xyz.mul(skinWeight.x)
      .add(m1.mul(n4).xyz.mul(skinWeight.y))
      .add(m2.mul(n4).xyz.mul(skinWeight.z))
      .add(m3.mul(n4).xyz.mul(skinWeight.w));

    // Instance transform — SAME as the live crowd: uniform scale → facing yaw (heading−90°) → world translate. The
    // ragdoll already placed the bones in output-local space (feet near y=0, tumbled in the LOCAL shot direction),
    // so there is NO whole-body topple here; the facing yaw maps the local tumble back into the world push direction.
    const scale = corpse.x;
    const facing = pose.w.sub(halfPi);
    const cf = cos(facing);
    const sf = sin(facing);
    const sx = local.x.mul(scale);
    const sy = local.y.mul(scale);
    const sz = local.z.mul(scale);
    const wx = cf.mul(sx).sub(sf.mul(sz)).add(pose.x);
    const wy = sy.add(pose.y);
    const wz = sf.mul(sx).add(cf.mul(sz)).add(pose.z);

    const nx = cf.mul(nrm.x).sub(sf.mul(nrm.z));
    const nz = sf.mul(nrm.x).add(cf.mul(nrm.z));
    normalLocal.assign(vec3(nx, nrm.y, nz).normalize());

    return vec3(wx, wy, wz);
  })();

  const baseTint = new Color(RIGGED_FALLBACK_COLOR);
  material.colorNode = Fn(() => {
    const seed = attribute<'vec4'>('iCorpse', 'vec4').w;
    const t = seed.div(denom);
    const brightness = float((1 - spread) * CORPSE_DARKEN).add(t.mul(spread * 2 * CORPSE_DARKEN));
    const base = albedo ? texture(albedo).rgb : vec3(baseTint.r, baseTint.g, baseTint.b);
    return base.mul(brightness);
  })();
  track(material as unknown as Disposable, 'material', `corpse.rigged.${key}.mat`);

  const mesh = new InstancedMesh(geo, material, cap);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = `corpse.rigged.${key}`;
  track(mesh as unknown as Disposable, 'buffer', `corpse.rigged.${key}.mesh`);

  return {
    corpseMesh: mesh,
    corpseArr,
    corpseBuf,
    corpseLive: 0,
  };
}

/**
 * The rigged near/mid-band crowd: per-archetype InstancedMeshes drawn from a baked bone texture (GPU skinning).
 * It draws every alive zombie the shared DISTANCE mask marks `BAND_RIGGED` (within the rigged distance); the far
 * band is drawn by the billboard impostor lane (CrowdImpostors), so every alive zombie is drawn by exactly one
 * lane (§B). There is NO count budget — the per-archetype InstancedMesh capacity (= the crowd instance capacity =
 * the sim zombie cap) is the only cap. Until every archetype GLB has baked, `isReady` is false and the Crowd draws
 * nothing (no boxes during the ~1s gap; the blob CorpseField covers corpses). Construction is GPU-free; only
 * `attach` (bake bone texture + impostor atlas) + frame submission touch real buffers/textures.
 */
export class RiggedCrowd {
  private readonly slots = new Map<ArchetypeKey, ArchetypeSlot>();
  private readonly settings: CrowdSettings;
  /** Per-archetype InstancedMesh capacity = the crowd instance capacity (the sim zombie cap). NO count budget —
   *  every in-view, alive, near-band zombie is drawn as a rigged figure; the total is bounded only by capacity. */
  private readonly budget: number;
  private readonly variationCount: number;
  private readonly scaleMin: number;
  private readonly scaleMax: number;
  /** T131/V99 — corpse pool render cap (sim corpse capacity); each archetype's corpse mesh is sized to it. Set at attach. */
  private corpseCapacity = 0;
  /** T134 — per-limb death-ragdoll tunables (resolved tier-correct by the caller; set at attach). */
  private ragdollConfig: RagdollConfig | null = null;
  /** T134 STATIC WORLD COLLISION — optional source of nearby WORLD colliders (walls/obstacles). Null ⇒ corpses only
   *  collide with the ground plane (the original behaviour). Set once by the scene (`setColliderSource`). */
  private colliderSource: WorldColliderSource | null = null;
  /** T134 — LIVE ragdolls keyed by dead-entity id (stable across frames as the corpse list re-orders/prunes). */
  private readonly ragdolls = new Map<number, Ragdoll>();
  /** T134 — recycled ragdoll instances (same particle/bone dims across archetypes) — no per-death alloc (V24). */
  private readonly freeRagdolls: Ragdoll[] = [];
  /** T134 — liveness generation: bumped each `updateCorpses`; ragdolls not seen this gen are freed. */
  private ragdollGen = 0;
  /** Per-SLOT normalized clip phase (stable identity, seeded so figures are not in lockstep). Lazily sized to SoA count. */
  private slotPhase: Float32Array | null = null;
  /** T132 state-crossfade per-SLOT bookkeeping (lazily sized with slotPhase). `slotClipId` is the current clip's
   *  unique startRow (−1 = never drawn); a CHANGE snapshots `slotLastRow` as the frozen FROM-pose and resets
   *  `slotBlend` to 0; `slotBlend` eases 0→1 (target weight). A freshly-seen member starts at blend 1 (no fade). */
  private slotClipId: Int32Array | null = null;
  private slotBlend: Float32Array | null = null;
  private slotFromRow: Float32Array | null = null;
  private slotLastRow: Float32Array | null = null;

  constructor(settings: CrowdSettings, private readonly parent: Object3D, private readonly impostors?: CrowdImpostors) {
    this.settings = settings;
    this.budget = settings.capacity;
    this.variationCount = settings.variationCount;
    this.scaleMin = settings.scaleMin;
    this.scaleMax = settings.scaleMax;
  }

  /** True once EVERY archetype GLB has been baked + attached — the Crowd switches the near band to rigged then. */
  get isReady(): boolean {
    return ARCHETYPE_KEYS.every((k) => this.slots.has(k));
  }

  /**
   * Bake + attach one archetype GLB (idempotent per key). Parents the rigged InstancedMesh AND its corpse-layer
   * mesh (T131/V99) under `parent` (the crowd mesh, already in the scene), so the existing scene wiring carries
   * both. `corpseCapacity` (the sim corpse pool cap, resolved tier-correct by the caller) sizes each archetype's
   * corpse mesh. Tracks every GPU resource (V24).
   */
  attach(key: ArchetypeKey, gltf: GLTF, track: TrackFn, corpseCapacity: number, ragdollConfig: RagdollConfig): void {
    if (this.slots.has(key)) return;
    this.corpseCapacity = corpseCapacity;
    this.ragdollConfig = ragdollConfig;
    const slot = buildArchetype(key, gltf, this.budget, corpseCapacity, this.settings, ragdollConfig, track);
    this.slots.set(key, slot);
    this.parent.add(slot.mesh);
    this.parent.add(slot.corpseMesh);
    // Bake this archetype's FAR-band billboard impostor from the SAME GLB (T140). Optional: the isolated
    // ragdoll-test harness constructs a RiggedCrowd with no impostor lane (single zombie, no far band).
    this.impostors?.bakeArchetype(key, gltf, track);
  }

  /** DEV/test-only (the ragdoll-test harness): the live ragdoll for a dead entity id, or undefined. Read-only —
   *  exposes the oriented-body sim state (`settled`, per-body `c/q`, emitted `bones`) for headless assertions. */
  debugRagdoll(entity: number): Ragdoll | undefined {
    return this.ragdolls.get(entity);
  }

  /**
   * T134 — install (or clear with `null`) the STATIC WORLD COLLIDER source. When set, each fresh corpse gathers the
   * nearby world colliders at spawn (within the config gather radius), so a launched body piles against walls/cars
   * instead of sliding through them. Default null ⇒ ground-plane-only collision (unchanged). The scene wires this
   * to the SAME nav/solidity data agents collide against (see `blockScene`).
   */
  setColliderSource(source: WorldColliderSource | null): void {
    this.colliderSource = source;
  }

  /**
   * Gather the static world colliders near a fresh corpse and transform them from WORLD into the corpse's LOCAL
   * output frame (the frame the ragdoll sim + the corpse shader use). The transform is the inverse of the shader's
   * local→world (`world = corpsePos + R(facing)·(scale·local)`): a world POINT p maps to `R(-facing)·(p − corpsePos)/scale`.
   * Using the SAME (cf,sf) as the impact-dir rotation keeps the colliders aligned with the body exactly. Circle radii
   * also divide by `scale` (body radii are already local). Returns undefined when no source is set or nothing is near.
   */
  private gatherColliders(worldX: number, worldZ: number, cf: number, sf: number, scale: number): RagdollColliders | undefined {
    const src = this.colliderSource;
    if (!src) return undefined;
    const radius = this.ragdollConfig?.colliderGatherRadius ?? 0;
    if (!(radius > 0)) return undefined;
    const world = src(worldX, worldZ, radius);
    const ws = world.segments;
    const wc = world.circles;
    if (ws.length === 0 && wc.length === 0) return undefined;
    const invScale = scale > 1e-6 ? 1 / scale : 1;
    const segments = new Float32Array(ws.length);
    for (let s = 0; s + 4 <= ws.length; s += 4) {
      const a0 = ws[s]! - worldX, a1 = ws[s + 1]! - worldZ; // endpoint 1 offset from corpse origin
      const b0 = ws[s + 2]! - worldX, b1 = ws[s + 3]! - worldZ; // endpoint 2
      segments[s] = (cf * a0 + sf * a1) * invScale;
      segments[s + 1] = (-sf * a0 + cf * a1) * invScale;
      segments[s + 2] = (cf * b0 + sf * b1) * invScale;
      segments[s + 3] = (-sf * b0 + cf * b1) * invScale;
    }
    const circles = new Float32Array(wc.length);
    for (let s = 0; s + 3 <= wc.length; s += 3) {
      const c0 = wc[s]! - worldX, c1 = wc[s + 1]! - worldZ;
      circles[s] = (cf * c0 + sf * c1) * invScale;
      circles[s + 1] = (-sf * c0 + cf * c1) * invScale;
      circles[s + 2] = wc[s + 2]! * invScale;
    }
    return { segments, circles };
  }

  /** Hide every rigged mesh (draw 0 instances) — used during the pre-bake gap (no boxes; nothing drawn). */
  hide(): void {
    for (const slot of this.slots.values()) slot.mesh.count = 0;
  }

  /**
   * T134 — mirror the sim CORPSE POOL onto the per-archetype corpse meshes as PER-LIMB RAGDOLLS: each dead body
   * goes LIMP and falls under physics from its killing shot (impactDir·force) instead of the rigid whole-body
   * topple. Each corpse owns a pooled CPU ragdoll keyed by its dead-entity id (stable as the corpse list re-orders
   * / prunes); a NEW corpse seeds a ragdoll from the frozen idle pose + the shot, every frame steps it by `dt`
   * (until SETTLED, then it freezes), and writes its 24 live bone matrices into the archetype's LIVE bone texture
   * at the corpse's row. The shader skins from that row (no topple). Routes each corpse to its archetype by
   * `archetypeKeyForIndex`; size + seed are stable per dead entity (deterministic V26). No-op (returns 0) until
   * every archetype is loaded — the blob `CorpseField` fallback covers that brief pre-bake window (no gap). Corpses
   * draw at full reveal (no vision cull). Allocation-free per frame after warm-up (V24). Returns the drawn count.
   */
  updateCorpses(corpses: readonly Corpse[], dtSeconds: number): number {
    if (!this.isReady) return 0;
    const cfg = this.ragdollConfig;
    if (!cfg) throw new Error('rigged corpse ragdoll config not set — attach() must run before updateCorpses');
    const cap = this.corpseCapacity;
    for (const slot of this.slots.values()) slot.corpseLive = 0;
    const gen = ++this.ragdollGen;

    const n = Math.min(corpses.length, cap);
    for (let ci = 0; ci < n; ci++) {
      const c = corpses[ci]!;
      const slot = this.slots.get(archetypeKeyForIndex(c.archetype))!;
      if (slot.corpseLive >= cap) continue;

      // Per-corpse size + seed are stable per dead entity (deterministic V26). Resolved BEFORE the get-or-seed so the
      // spawn collider gather can divide world distances by this corpse's scale into the local frame.
      const seed = variationSeed((c.entity >>> 0) ^ CORPSE_SEED_SALT, this.variationCount);
      const scale = variationScale(seed, this.variationCount, this.scaleMin, this.scaleMax);

      // Get-or-seed this corpse's ragdoll (keyed by stable entity id). A fresh corpse is launched from the killing
      // shot: rotate the WORLD impact dir into the corpse's LOCAL frame (the shader re-applies the facing yaw), then
      // seed the impulse + per-corpse jitter from a deterministic PRNG (V26 — same death reproduces the same fall).
      let rag = this.ragdolls.get(c.entity);
      if (!rag) {
        rag = this.freeRagdolls.pop() ?? new Ragdoll(slot.ragSpec);
        const facing = c.heading - Math.PI / 2;
        const cf = Math.cos(facing);
        const sf = Math.sin(facing);
        const localX = cf * c.impactDirX + sf * c.impactDirZ;
        const localZ = -sf * c.impactDirX + cf * c.impactDirZ;
        // STATIC WORLD COLLISION — gather the nearby walls/obstacles ONCE at spawn, transformed into this corpse's
        // LOCAL frame with the EXACT inverse of the render facing yaw + scale (same cf,sf as the impact dir).
        const colliders = this.gatherColliders(c.x, c.z, cf, sf, scale);
        rag.reset(slot.ragSpec, cfg, localX, localZ, c.impactForce, mulberry32((c.entity >>> 0) ^ RAGDOLL_SEED_SALT), colliders);
        this.ragdolls.set(c.entity, rag);
      }
      if (!rag.settled) rag.step(cfg, dtSeconds);
      rag.gen = gen;

      const i = slot.corpseLive;
      // Write the ragdoll's 24 live bone matrices into this corpse's row of the archetype's live bone texture.
      rag.writeBones(slot.liveBoneData, i * slot.boneCount * 16);
      const b = i * FLOATS_PER_CORPSE_INSTANCE;
      const pp = b + CORPSE_INST_POSE;
      const pa = b + CORPSE_INST_ANIM;
      slot.corpseArr[pp] = c.x;
      slot.corpseArr[pp + 1] = c.y;
      slot.corpseArr[pp + 2] = c.z;
      slot.corpseArr[pp + 3] = c.heading;
      slot.corpseArr[pa] = scale;
      slot.corpseArr[pa + 1] = i; // liveBoneRow — this corpse's row in the live ragdoll bone texture
      slot.corpseArr[pa + 2] = 0;
      slot.corpseArr[pa + 3] = seed;
      slot.corpseLive++;
    }

    // Recycle ragdolls whose corpse vanished this frame (pruned/expired) — no per-death allocation (V24).
    for (const [entity, rag] of this.ragdolls) {
      if (rag.gen !== gen) {
        this.ragdolls.delete(entity);
        this.freeRagdolls.push(rag);
      }
    }

    let total = 0;
    for (const slot of this.slots.values()) {
      slot.corpseBuf.needsUpdate = true;
      slot.liveBoneTex.needsUpdate = true;
      slot.corpseMesh.count = slot.corpseLive;
      total += slot.corpseLive;
    }
    return total;
  }

  /**
   * Pack the limbed-band live zombies into their archetype's instance buffers for this frame + advance each
   * slot's clip phase. Returns the total drawn count. No-op (returns 0) until every archetype is loaded.
   * Allocation-free per frame (V24): reuses the per-archetype Float32Arrays + the per-slot phase accumulator.
   *
   * `count` here is the SoA SLOT-SCAN EXTENT (= capacity, passed down from crowd.update's `slotCount`), NOT the
   * alive population — the SoA is a sparse free-list, so the loop scans every slot and skips dead ones. Bounding
   * it to the alive count would drop high-index alive zombies from the draw (the invisible-enemy bug).
   */
  update(views: FieldViews, count: number, dtSeconds: number, visibility?: VisionCull, figureMask?: Uint8Array): number {
    if (!this.isReady) return 0;

    // Per-SLOT clip phase, lazily sized to the SoA count + seeded with a per-slot offset (mirrors the limb tier).
    if (!this.slotPhase || this.slotPhase.length < count) {
      const next = new Float32Array(count);
      const denom = Math.max(1, this.variationCount);
      for (let s = 0; s < count; s++) next[s] = variationSeed(s, denom) / denom;
      if (this.slotPhase) next.set(this.slotPhase.subarray(0, Math.min(this.slotPhase.length, count)));
      this.slotPhase = next;
      // T132 — grow the crossfade bookkeeping in lockstep. New slots start "never drawn" (clipId −1, blend 1) so a
      // first appearance shows its clip directly (no fade from a garbage pose); existing slots keep their state.
      const clipId = new Int32Array(count).fill(-1);
      const blendW = new Float32Array(count).fill(1);
      const fromRow = new Float32Array(count);
      const lastRow = new Float32Array(count);
      if (this.slotClipId) {
        const keep = Math.min(this.slotClipId.length, count);
        clipId.set(this.slotClipId.subarray(0, keep));
        blendW.set(this.slotBlend!.subarray(0, keep));
        fromRow.set(this.slotFromRow!.subarray(0, keep));
        lastRow.set(this.slotLastRow!.subarray(0, keep));
      }
      this.slotClipId = clipId;
      this.slotBlend = blendW;
      this.slotFromRow = fromRow;
      this.slotLastRow = lastRow;
    }
    const slotPhase = this.slotPhase;
    const slotClipId = this.slotClipId!;
    const slotBlend = this.slotBlend!;
    const slotFromRow = this.slotFromRow!;
    const slotLastRow = this.slotLastRow!;

    for (const slot of this.slots.values()) slot.live = 0;

    const alive = requireView<Uint8Array>(views, 'alive');
    const position = requireView<Float32Array>(views, 'position');
    const heading = requireView<Float32Array>(views, 'heading');
    const state = requireView<Uint8Array>(views, 'state');
    const archetype = requireView<Uint16Array>(views, 'archetype');
    const velocity = requireView<Float32Array>(views, 'velocity');

    // The near band: every alive slot the shared distance mask marks BAND_RIGGED (the far band is drawn by the
    // impostor lane). When NO mask is supplied (the isolated ragdoll-test single-zombie path), every alive
    // in-view zombie is rigged. NO count budget — the per-archetype capacity is the only cap (§B: each alive
    // zombie is drawn by exactly one lane).
    for (let s = 0; s < count; s++) {
      if (alive[s] === 0) continue;
      if (figureMask && figureMask[s] !== BAND_RIGGED) continue; // far band → impostor lane draws it

      // Vision-cone fog-of-war (T96) + perception v2 (V62): read the precomputed per-slot reveal, else the cone fade.
      let fade = 1;
      if (visibility) {
        fade = visibility.reveal ? visibility.reveal[s]! : visionCullFade(position[s * 3]!, position[s * 3 + 2]!, visibility);
        if (fade <= 0) continue;
      }

      const slot = this.slots.get(archetypeKeyForIndex(archetype[s]!))!;
      if (slot.live >= this.budget) continue; // per-archetype mesh capacity guard (== crowd instance capacity)

      const st = state[s]!;
      const clipName = clipForState(CLIP_MAPS[slot.key], st);
      const entry = slot.table.entries.get(clipName);
      if (!entry) throw new Error(`rigged '${slot.key}' has no baked clip '${clipName}'`);
      // Pace the clip to the member's ACTUAL ground speed so a slow shambler's legs don't windmill and a fast
      // runner's don't moonwalk (T128): cadence = speed / clip-stride for moving locomotion, natural rate else.
      const speed = Math.hypot(velocity[s * 3]!, velocity[s * 3 + 2]!);
      // FROZEN idle: an archetype with no real idle clip (runner → Casual_Walk fallback) holds a pose instead of
      // walking on the spot while standing still (V96 asset limitation); else pace the clip to ground speed.
      const rate = isFrozenIdle(CLIP_MAPS[slot.key], st)
        ? 0
        : locomotionRateHz(isLocomotionState(st), speed, slot.strideByName.get(clipName) ?? 0, clipPhaseRateHz(entry));
      // Per-slot cadence jitter (stable, deterministic) so members don't stride in identical-rate lockstep.
      const jitter = 1 + (variationHash01(s, CADENCE_SALT) - 0.5) * 2 * CADENCE_JITTER_SPREAD;
      const ph = advancePhase(slotPhase[s]!, rate * jitter, dtSeconds);
      slotPhase[s] = ph;
      const targetRow = phaseToFrameRow(entry, ph);

      // T132 state crossfade: on a clip CHANGE, freeze the last drawn frame as the FROM-pose + restart the blend;
      // ease the target weight 0→1 over STATE_BLEND_SECONDS so the body morphs between poses instead of popping.
      const clipId = entry.startRow; // unique per clip within this archetype (the slot's archetype is fixed)
      if (slotClipId[s]! >= 0 && slotClipId[s]! !== clipId) {
        slotFromRow[s] = slotLastRow[s]!;
        slotBlend[s] = 0;
      }
      slotClipId[s] = clipId;
      const w = Math.min(1, slotBlend[s]! + dtSeconds / STATE_BLEND_SECONDS);
      slotBlend[s] = w;
      slotLastRow[s] = targetRow;

      const seed = variationSeed(s, this.variationCount);
      const i = slot.live;
      const b = i * FLOATS_PER_INSTANCE;
      const pp = b + INST_POSE;
      const pa = b + INST_ANIM;
      const pb = b + INST_BLEND;
      slot.instArr[pp] = position[s * 3]!;
      slot.instArr[pp + 1] = position[s * 3 + 1]!;
      slot.instArr[pp + 2] = position[s * 3 + 2]!;
      slot.instArr[pp + 3] = heading[s]!;
      slot.instArr[pa] = targetRow;
      slot.instArr[pa + 1] = variationScale(seed, this.variationCount, this.scaleMin, this.scaleMax);
      slot.instArr[pa + 2] = fade;
      slot.instArr[pa + 3] = seed;
      slot.instArr[pb] = slotFromRow[s]!; // from-pose frame row
      slot.instArr[pb + 1] = w; // target weight (1 = fully on the new clip)
      slot.instArr[pb + 2] = 0; // spare — future per-instance effect channel (damage flash / wetness)
      slot.instArr[pb + 3] = 0;
      slot.live++;
    }

    let total = 0;
    for (const slot of this.slots.values()) {
      slot.instBuf.needsUpdate = true;
      slot.mesh.count = slot.live;
      total += slot.live;
    }
    return total;
  }
}
