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
import type { CrowdSettings } from './crowd';
import { variationHash01, variationScale, variationSeed } from './packing';
import { visionCullFade, type VisionCull } from './visionCull';
import { corpseTopple, CORPSE_LIE_HEIGHT, CORPSE_PRONE_PITCH } from '../corpse/corpseTopple';
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
/** Rigged crowd standing height (m) — matches the player avatar (T127) so scale reads consistently. */
const RIGGED_HEIGHT_METERS = 1.8;
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

/** Registry track signature handed in from BlockScene (V24). */
export type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;

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
  /** T133 — INTERLEAVED per-corpse data (one slot, 2 attributes): iPose@0 [px,py,pz,heading] · iCorpse@4
   *  [scale, topplePitch, fallYaw, variationSeed]. */
  readonly corpseArr: Float32Array;
  readonly corpseBuf: InstancedInterleavedBuffer;
  corpseLive: number;
}

/**
 * Bake one archetype GLB to a bone-matrix animation texture + build its rigged InstancedMesh + shared skinning
 * material. GPU-device-free (AnimationMixer + Skeleton.update are CPU); only the texture/buffer UPLOAD needs the
 * device, on first render. Returns everything the RiggedCrowd needs to pack + draw that archetype.
 */
function buildArchetype(key: ArchetypeKey, gltf: GLTF, budget: number, corpseCapacity: number, settings: CrowdSettings, track: TrackFn): ArchetypeSlot {
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
  const leftConst = new Matrix4()
    .makeTranslation(0, -box.min.y * fit, 0)
    .multiply(new Matrix4().makeScale(fit, fit, fit))
    .multiply(mesh.matrixWorld)
    .multiply(mesh.bindMatrixInverse);
  const bindMatrix = mesh.bindMatrix;

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

  // ---- T131/V99 CORPSE layer: the SAME rigged mesh, FROZEN at a neutral standing frame + toppled prone along the
  // killing shot. Reuses the baked bone texture + albedo; a CLONED geometry carries its own per-corpse instance
  // attributes so the corpse pool never double-draws the live crowd. The frozen clip row is a per-archetype const
  // (every corpse samples the same neutral pose), so the shader needs no per-instance frame attribute. ----
  const frozenRow = table.entries.get(CLIP_MAPS[key][CORPSE_FROZEN_CLIP])!.startRow;
  const corpseSlot = buildCorpseLayer(key, geometry, boneTex, albedo, frozenRow, corpseCapacity, denom, spread, track);

  return {
    key,
    mesh: inst,
    table,
    strideByName,
    instArr,
    instBuf,
    live: 0,
    ...corpseSlot,
  };
}

/**
 * T131/V99 — build one archetype's CORPSE InstancedMesh: a frozen-frame, impact-toppled body. Reuses the live
 * crowd's baked `boneTex` + `albedo` (same zombie, scene-lit), on a CLONED geometry that SHARES the vertex data
 * (position/normal/uv/skinIndex/skinWeight) but carries its OWN per-corpse instance attributes — so the corpse
 * pool draws independently of the live crowd (no double-draw). The skinning math mirrors the live `positionNode`
 * but, after the facing yaw, applies the per-instance impact TOPPLE (Rodrigues about a horizontal axis through the
 * feet) — front shot tips onto the back, side topples sideways. Per-corpse data is INTERLEAVED into one instanced
 * buffer (T133), so this is 6/8 vertex-buffer slots (5 mesh + 1 instance). Every GPU resource is registry-tracked (V24).
 */
type CorpseLayer = Pick<ArchetypeSlot, 'corpseMesh' | 'corpseArr' | 'corpseBuf' | 'corpseLive'>;

function buildCorpseLayer(
  key: ArchetypeKey,
  liveGeo: BufferGeometry,
  boneTex: Texture,
  albedo: Texture | null,
  frozenRow: number,
  capacity: number,
  denom: number,
  spread: number,
  track: TrackFn,
): CorpseLayer {
  const cap = Math.max(1, capacity);

  // CLONE the geometry (own GPU buffers → safe independent disposal) then strip the live instanced attributes and
  // install the corpse's own pose + topple attributes. The base vertex attributes (position/normal/uv/skin*) ride
  // along the clone, so the corpse renders the identical mesh.
  const geo = liveGeo.clone();
  if (geo.getAttribute('iPose')) geo.deleteAttribute('iPose');
  if (geo.getAttribute('iAnim')) geo.deleteAttribute('iAnim');
  if (geo.getAttribute('iBlend')) geo.deleteAttribute('iBlend'); // T132 live-only attr — corpse pose is static
  // T133 — interleave the corpse's pose + topple into ONE instanced buffer (iPose@0, iCorpse@4): 1 slot, 2 attrs.
  const corpseArr = new Float32Array(cap * FLOATS_PER_CORPSE_INSTANCE);
  const corpseBuf = new InstancedInterleavedBuffer(corpseArr, FLOATS_PER_CORPSE_INSTANCE);
  corpseBuf.setUsage(DynamicDrawUsage);
  geo.setAttribute('iPose', new InterleavedBufferAttribute(corpseBuf, 4, CORPSE_INST_POSE));
  geo.setAttribute('iCorpse', new InterleavedBufferAttribute(corpseBuf, 4, CORPSE_INST_ANIM));
  track(geo as unknown as Disposable, 'geometry', `corpse.rigged.${key}.geo`);

  const material = new MeshStandardNodeMaterial({ name: `corpse.rigged.${key}` });
  material.metalness = 0;
  material.roughness = 0.92; // a settled body is matte
  const halfPi = CORPSE_PRONE_PITCH; // = π/2 (the standing→facing yaw offset AND the prone topple)
  const liftPerRad = CORPSE_LIE_HEIGHT / CORPSE_PRONE_PITCH; // lift = LIE_HEIGHT·(pitch/(π/2)) (derived from pitch)

  material.positionNode = Fn(() => {
    const skinIndex = attribute<'uvec4'>('skinIndex', 'uvec4');
    const skinWeight = attribute<'vec4'>('skinWeight', 'vec4');
    const pose = attribute<'vec4'>('iPose', 'vec4'); // [posX, posY, posZ, heading]
    const corpse = attribute<'vec4'>('iCorpse', 'vec4'); // [scale, topplePitch, fallYaw, seed]
    const row = int(frozenRow); // CONSTANT neutral frame — every corpse samples the same standing pose

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

    // Topple basis: facing yaw (heading−90°, SAME convention as the live crowd) THEN a tip about the horizontal
    // axis a=(sinψ, 0, −cosψ) by `pitch` (ψ = fallYaw). Rodrigues for a horizontal axis (aᵧ=0), pivoting at the
    // feet (origin), so the body tips over in the world fall direction. lift rises with pitch so it rests flat.
    const scale = corpse.x;
    const pitch = corpse.y;
    const psi = corpse.z;
    const facing = pose.w.sub(halfPi);
    const cf = cos(facing);
    const sf = sin(facing);
    const ct = cos(pitch);
    const st = sin(pitch);
    const ax = sin(psi);
    const az = cos(psi).mul(-1);
    const omct = float(1).sub(ct);

    // --- POSITION: scale → facing yaw → topple (Rodrigues) → translate + lift ---
    const sx = local.x.mul(scale);
    const sy = local.y.mul(scale);
    const sz = local.z.mul(scale);
    const fx = cf.mul(sx).sub(sf.mul(sz));
    const fy = sy;
    const fz = sf.mul(sx).add(cf.mul(sz));
    const adot = ax.mul(fx).add(az.mul(fz));
    const tx = fx.mul(ct).add(az.mul(fy).mul(st).mul(-1)).add(ax.mul(adot).mul(omct));
    const ty = fy.mul(ct).add(az.mul(fx).sub(ax.mul(fz)).mul(st));
    const tz = fz.mul(ct).add(ax.mul(fy).mul(st)).add(az.mul(adot).mul(omct));
    const lift = pitch.mul(liftPerRad);

    // --- NORMAL: same facing yaw + topple (no scale / translate), then renormalize ---
    const fnx = cf.mul(nrm.x).sub(sf.mul(nrm.z));
    const fny = nrm.y;
    const fnz = sf.mul(nrm.x).add(cf.mul(nrm.z));
    const adotn = ax.mul(fnx).add(az.mul(fnz));
    const nx = fnx.mul(ct).add(az.mul(fny).mul(st).mul(-1)).add(ax.mul(adotn).mul(omct));
    const ny = fny.mul(ct).add(az.mul(fnx).sub(ax.mul(fnz)).mul(st));
    const nz = fnz.mul(ct).add(ax.mul(fny).mul(st)).add(az.mul(adotn).mul(omct));
    normalLocal.assign(vec3(nx, ny, nz).normalize());

    return vec3(tx.add(pose.x), ty.add(pose.y).add(lift), tz.add(pose.z));
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
 * The rigged near-band crowd: per-archetype InstancedMeshes drawn from a baked bone texture (GPU skinning). It
 * REPLACES the procedural CrowdLimbs once all archetype GLBs have loaded (until then `isReady` is false and the
 * Crowd keeps drawing the limbed figures, so there is never a visible gap). It consumes the SAME limbed-band
 * partition (simTier <= maxSimTier, first `budget` ranks) as packCrowdInputs/packLimbInputs, so the box horde
 * keeps drawing exactly the far + overflow members — every alive zombie is drawn by exactly one path.
 * Construction is GPU-free; only `attach` (bake) + frame submission touch real buffers/textures.
 */
export class RiggedCrowd {
  private readonly slots = new Map<ArchetypeKey, ArchetypeSlot>();
  private readonly settings: CrowdSettings;
  private readonly budget: number;
  private readonly maxSimTier: number;
  private readonly variationCount: number;
  private readonly scaleMin: number;
  private readonly scaleMax: number;
  /** T131/V99 — corpse pool render cap (sim corpse capacity); each archetype's corpse mesh is sized to it. Set at attach. */
  private corpseCapacity = 0;
  /** Per-SLOT normalized clip phase (stable identity, seeded so figures are not in lockstep). Lazily sized to SoA count. */
  private slotPhase: Float32Array | null = null;
  /** T132 state-crossfade per-SLOT bookkeeping (lazily sized with slotPhase). `slotClipId` is the current clip's
   *  unique startRow (−1 = never drawn); a CHANGE snapshots `slotLastRow` as the frozen FROM-pose and resets
   *  `slotBlend` to 0; `slotBlend` eases 0→1 (target weight). A freshly-seen member starts at blend 1 (no fade). */
  private slotClipId: Int32Array | null = null;
  private slotBlend: Float32Array | null = null;
  private slotFromRow: Float32Array | null = null;
  private slotLastRow: Float32Array | null = null;

  constructor(settings: CrowdSettings, private readonly parent: Object3D) {
    this.settings = settings;
    this.budget = settings.limbedBudget;
    this.maxSimTier = settings.limbedMaxSimTier;
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
  attach(key: ArchetypeKey, gltf: GLTF, track: TrackFn, corpseCapacity: number = this.budget): void {
    if (this.slots.has(key)) return;
    this.corpseCapacity = corpseCapacity;
    const slot = buildArchetype(key, gltf, this.budget, corpseCapacity, this.settings, track);
    this.slots.set(key, slot);
    this.parent.add(slot.mesh);
    this.parent.add(slot.corpseMesh);
  }

  /** Hide every rigged mesh (draw 0 instances) — used while the limbed fallback owns the near band. */
  hide(): void {
    for (const slot of this.slots.values()) slot.mesh.count = 0;
  }

  /**
   * T131/V99 — mirror the sim CORPSE POOL onto the per-archetype corpse meshes: each dead body renders as its
   * archetype's rigged mesh FROZEN at a neutral standing frame, then toppled prone along the killing shot's push
   * direction (`corpseTopple`) over `collapseTicks`, pivoting at the feet. Routes each corpse to its archetype by
   * `archetypeKeyForIndex`; size + seed are stable per dead entity (deterministic V26). No-op (returns 0) until
   * every archetype is loaded — the blob `CorpseField` fallback covers that brief pre-bake window (V95-style, no
   * gap). Corpses draw at full reveal (no vision cull), so body-anchored gore stays consistent with them (V90 —
   * a corpse's gore fades by AGE, not reveal). Allocation-free per frame (V24). `nowAbsTick` is the runtime's
   * absolute tick the corpse `bornTick` was stamped in. Returns the total drawn count.
   */
  updateCorpses(corpses: readonly Corpse[], nowAbsTick: number, collapseTicks: number): number {
    if (!this.isReady) return 0;
    const cap = this.corpseCapacity;
    for (const slot of this.slots.values()) slot.corpseLive = 0;

    const n = Math.min(corpses.length, cap);
    for (let ci = 0; ci < n; ci++) {
      const c = corpses[ci]!;
      const slot = this.slots.get(archetypeKeyForIndex(c.archetype))!;
      if (slot.corpseLive >= cap) continue;
      const t = corpseTopple(c.impactDirX, c.impactDirZ, c.impactForce, nowAbsTick - c.bornTick, collapseTicks, c.heading);
      const seed = variationSeed((c.entity >>> 0) ^ CORPSE_SEED_SALT, this.variationCount);
      const scale = variationScale(seed, this.variationCount, this.scaleMin, this.scaleMax);
      const i = slot.corpseLive;
      const b = i * FLOATS_PER_CORPSE_INSTANCE;
      const pp = b + CORPSE_INST_POSE;
      const pa = b + CORPSE_INST_ANIM;
      slot.corpseArr[pp] = c.x;
      slot.corpseArr[pp + 1] = c.y;
      slot.corpseArr[pp + 2] = c.z;
      slot.corpseArr[pp + 3] = c.heading;
      slot.corpseArr[pa] = scale;
      slot.corpseArr[pa + 1] = t.pitch;
      slot.corpseArr[pa + 2] = t.fallYaw;
      slot.corpseArr[pa + 3] = seed;
      slot.corpseLive++;
    }

    let total = 0;
    for (const slot of this.slots.values()) {
      slot.corpseBuf.needsUpdate = true;
      slot.corpseMesh.count = slot.corpseLive;
      total += slot.corpseLive;
    }
    return total;
  }

  /**
   * Pack the limbed-band live zombies into their archetype's instance buffers for this frame + advance each
   * slot's clip phase. Returns the total drawn count. No-op (returns 0) until every archetype is loaded.
   * Allocation-free per frame (V24): reuses the per-archetype Float32Arrays + the per-slot phase accumulator.
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
    const simTier = requireView<Uint8Array>(views, 'simTier');
    const state = requireView<Uint8Array>(views, 'state');
    const archetype = requireView<Uint16Array>(views, 'archetype');
    const velocity = requireView<Float32Array>(views, 'velocity');

    // `rank` counts limbed-eligible alive slots in slot order, IDENTICALLY to packCrowdInputs' figureRank /
    // packLimbInputs' rank, so the box path draws exactly the far + over-budget members (no double-draw, no gap).
    let rank = 0;
    for (let s = 0; s < count; s++) {
      if (alive[s] === 0) continue;
      if (figureMask) {
        // Distance-ranked partition — draw only the shared mask's near figures (identical to the box + limb passes).
        if (figureMask[s] !== 1) continue;
      } else {
        if (simTier[s]! > this.maxSimTier) continue; // not near-band → drawn as a box
        if (rank++ >= this.budget) continue; // beyond the pool cap → the box path draws this overflow figure
      }

      // Vision-cone fog-of-war (T96) + perception v2 (V62): read the precomputed per-slot reveal, else the cone fade.
      let fade = 1;
      if (visibility) {
        fade = visibility.reveal ? visibility.reveal[s]! : visionCullFade(position[s * 3]!, position[s * 3 + 2]!, visibility);
        if (fade <= 0) continue;
      }

      const slot = this.slots.get(archetypeKeyForIndex(archetype[s]!))!;
      if (slot.live >= this.budget) continue; // per-archetype mesh capacity guard (== total budget)

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
