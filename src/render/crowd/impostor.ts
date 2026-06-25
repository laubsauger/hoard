// T140 / V2 / V3 / V24 — FAR-BAND billboard IMPOSTOR lane. Replaces the old BoxGeometry far/horde LOD with a
// baked, multi-angle (azimuthal) sprite atlas drawn as instanced, camera-facing QUADS — so a far zombie reads
// as a recognizable zombie SILHOUETTE, never a box.
//
// The atlas is baked ONCE per archetype at GLB attach, on the CPU (NO renderer/GPU needed at bake — it fits the
// engine's GPU-free attach path): the GLB's bind-pose geometry is fitted to the rigged height (feet at y=0) and
// software-rasterized from `angleCount` yaw views around the figure into a tiled RGBA atlas (half-lambert shaded
// silhouette, coverage in alpha). At draw time ONE instanced quad per archetype samples the tile whose baked
// yaw is nearest the current view-vs-facing azimuth, oriented as a Y-up cylindrical billboard. Per instance:
// world pos, facing heading, scale, variation seed (tint/brightness), and the SAME reveal fade the rigged lane
// uses (V65). Every GPU resource is registry-tracked (V24). Allocation-free per frame after warm-up.

import {
  Color,
  DataTexture,
  DynamicDrawUsage,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
  LinearFilter,
  PlaneGeometry,
  RGBAFormat,
  UnsignedByteType,
  type BufferGeometry,
  type Mesh,
  type Object3D,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, atan, attribute, cameraPosition, cos, float, floor, mod, positionLocal, sin, texture, vec2, vec3 } from 'three/tsl';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { FieldViews } from '../../game/core/contracts/soa';
import type { Disposable } from '../engine/resources';
import type { CrowdSettings } from './crowd';
import type { TrackFn } from './rigged';
import { BAND_RIGGED, variationScale, variationSeed } from './packing';
import { ARCHETYPE_KEYS, archetypeKeyForIndex, type ArchetypeKey } from './riggedAnim';
import { visionCullFade, type VisionCull } from './visionCull';

const TAU = Math.PI * 2;
/** Flesh/clothing base tone the silhouette is shaded from (decayed olive; per-instance brightness varies it). Tuned
 *  to read at roughly the same luminance as the rigged GLB albedo so the LOD swap doesn't darken the far band. */
const IMPOSTOR_BASE_COLOR = 0x8c9670;
/** Half-lambert ambient floor + diffuse gain for the baked silhouette shading (reads as a lit figure, not a flat cut-out). */
const IMPOSTOR_AMBIENT = 0.6;
const IMPOSTOR_DIFFUSE = 0.55;
/** Baked light direction (world, upper front-ish) — matches the scene key roughly so the impostor lighting agrees. */
const LIGHT_DIR: readonly [number, number, number] = [0.35, 0.7, 0.45];
/** Horizontal margin (×) added around the fitted figure when framing each tile, so the silhouette never clips. */
const FRAME_MARGIN = 1.12;
/** 8 floats per impostor instance, interleaved into ONE instanced buffer (1 slot): iImp [px,py,pz,heading] +
 *  iImp2 [scale, seed, revealFade, _]. PlaneGeometry uses 3 vertex buffers → 4/8 with the one instance slot. */
const FLOATS_PER_INSTANCE = 8;
const INST_POSE = 0;
const INST_META = 4;

/** The baked sprite atlas for one archetype + the world dims its tiles frame (T140). */
export interface ImpostorAtlas {
  /** RGBA8, row-major, width*height*4. Row 0 = the FEET of the figure (v=0 at the feet). */
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly tileW: number;
  readonly tileH: number;
  readonly angleCount: number;
  /** World meters the tile WIDTH spans (the billboard quad width) and the figure HEIGHT (the quad height). */
  readonly worldWidth: number;
  readonly worldHeight: number;
}

export interface BakeImpostorOptions {
  readonly angleCount: number;
  readonly tileH: number;
  readonly maxTriangles: number;
  /** Output figure height in meters (feet at y=0) — matches the rigged crowd height so LOD reads consistently. */
  readonly heightMeters: number;
}

function firstMesh(gltf: GLTF): Mesh {
  let found: Mesh | null = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    const m = o as Mesh;
    if (!found && (m as { isMesh?: boolean }).isMesh && m.geometry) found = m;
  });
  if (!found) throw new Error('impostor bake: GLB has no Mesh geometry');
  return found;
}

/**
 * Bake the azimuthal silhouette atlas for one archetype's GLB (PURE CPU, no GPU). Fits the bind-pose geometry to
 * `heightMeters` (feet at y=0, centred in XZ), then software-rasterizes `angleCount` yaw views into a tiled RGBA
 * atlas with a half-lambert shaded flesh tone + coverage alpha. Deterministic given the GLB (V26) and unit-testable
 * without a renderer. A dense GLB is uniformly strided down to `maxTriangles` so the one-time bake stays fast.
 */
export function bakeImpostorAtlas(gltf: GLTF, opts: BakeImpostorOptions): ImpostorAtlas {
  const mesh = firstMesh(gltf);
  const geo = mesh.geometry as BufferGeometry;
  const posAttr = geo.getAttribute('position');
  if (!posAttr) throw new Error('impostor bake: geometry has no position attribute');
  const idxAttr = geo.getIndex();
  const mw = mesh.matrixWorld.elements;

  // World-transform every vertex (bind pose) once, into a flat array.
  const vcount = posAttr.count;
  const wp = new Float32Array(vcount * 3);
  for (let i = 0; i < vcount; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    // column-major mat4 * (x,y,z,1)
    wp[i * 3] = mw[0]! * x + mw[4]! * y + mw[8]! * z + mw[12]!;
    wp[i * 3 + 1] = mw[1]! * x + mw[5]! * y + mw[9]! * z + mw[13]!;
    wp[i * 3 + 2] = mw[2]! * x + mw[6]! * y + mw[10]! * z + mw[14]!;
  }

  // Bounds → fit to height, seat feet at y=0, centre XZ at origin.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < vcount; i++) {
    const x = wp[i * 3]!, y = wp[i * 3 + 1]!, z = wp[i * 3 + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const sizeY = maxY - minY;
  const fit = sizeY > 1e-6 ? opts.heightMeters / sizeY : 1;
  const cx = (minX + maxX) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  for (let i = 0; i < vcount; i++) {
    wp[i * 3] = (wp[i * 3]! - cx) * fit;
    wp[i * 3 + 1] = (wp[i * 3 + 1]! - minY) * fit;
    wp[i * 3 + 2] = (wp[i * 3 + 2]! - cz) * fit;
  }
  const worldHeight = opts.heightMeters;
  const halfW = Math.max(maxX - minX, maxZ - minZ) * 0.5 * fit * FRAME_MARGIN;
  const worldWidth = halfW * 2;

  // Tile dims from the figure aspect; clamp so it stays a sensible portrait sprite.
  const tileH = Math.max(8, Math.round(opts.tileH));
  let tileW = Math.round((tileH * worldWidth) / worldHeight);
  tileW = Math.max(8, Math.min(tileW, tileH)); // never wider than tall
  const N = Math.max(1, Math.round(opts.angleCount));
  const width = tileW * N;
  const height = tileH;
  const data = new Uint8Array(width * height * 4); // zero = transparent background

  const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(vcount / 3);
  const stride = Math.max(1, Math.ceil(triCount / Math.max(1, opts.maxTriangles)));

  const base = new Color(IMPOSTOR_BASE_COLOR);
  const ll = Math.hypot(LIGHT_DIR[0], LIGHT_DIR[1], LIGHT_DIR[2]);
  const lx = LIGHT_DIR[0] / ll, ly = LIGHT_DIR[1] / ll, lz = LIGHT_DIR[2] / ll;

  const zbuf = new Float32Array(tileW * tileH);
  const idx = (i: number): number => (idxAttr ? idxAttr.getX(i) : i);

  for (let k = 0; k < N; k++) {
    const phi = (k * TAU) / N;
    // Screen-right (image x) + forward (depth) for a camera at local azimuth phi looking at the figure.
    // right = (-cos phi, 0, sin phi); forward = (-sin phi, 0, -cos phi). up = +Y (figure stays upright).
    const rx = -Math.cos(phi), rz = Math.sin(phi);
    const fx = -Math.sin(phi), fz = -Math.cos(phi);
    const tileX0 = k * tileW;
    zbuf.fill(Infinity);

    for (let t = 0; t < triCount; t += stride) {
      const a = idx(t * 3), b = idx(t * 3 + 1), c = idx(t * 3 + 2);
      const ax = wp[a * 3]!, ay = wp[a * 3 + 1]!, az = wp[a * 3 + 2]!;
      const bx = wp[b * 3]!, by = wp[b * 3 + 1]!, bz = wp[b * 3 + 2]!;
      const ccx = wp[c * 3]!, ccy = wp[c * 3 + 1]!, ccz = wp[c * 3 + 2]!;
      // Project to image space: px = screen-right · p mapped to [0,tileW]; py = height mapped to [0,tileH] (feet row 0).
      const pax = ((ax * rx + az * rz) / halfW * 0.5 + 0.5) * tileW;
      const pay = (ay / worldHeight) * tileH;
      const pbx = ((bx * rx + bz * rz) / halfW * 0.5 + 0.5) * tileW;
      const pby = (by / worldHeight) * tileH;
      const pcx = ((ccx * rx + ccz * rz) / halfW * 0.5 + 0.5) * tileW;
      const pcy = (ccy / worldHeight) * tileH;
      const da = ax * fx + az * fz; // depth (smaller = closer to camera)
      const db = bx * fx + bz * fz;
      const dc = ccx * fx + ccz * fz;

      // Face normal (fitted positions) for half-lambert shading.
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = ccx - ax, e2y = ccy - ay, e2z = ccz - az;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const ndl = nx * lx + ny * ly + nz * lz;
      const shade = IMPOSTOR_AMBIENT + IMPOSTOR_DIFFUSE * (ndl * 0.5 + 0.5);
      const r = Math.min(255, base.r * shade * 255) | 0;
      const g = Math.min(255, base.g * shade * 255) | 0;
      const bl = Math.min(255, base.b * shade * 255) | 0;

      // Bounding-box rasterize with the edge function; z-test per pixel.
      let bx0 = Math.floor(Math.min(pax, pbx, pcx));
      let bx1 = Math.ceil(Math.max(pax, pbx, pcx));
      let by0 = Math.floor(Math.min(pay, pby, pcy));
      let by1 = Math.ceil(Math.max(pay, pby, pcy));
      if (bx0 < 0) bx0 = 0; if (by0 < 0) by0 = 0;
      if (bx1 > tileW) bx1 = tileW; if (by1 > tileH) by1 = tileH;
      const area = (pbx - pax) * (pcy - pay) - (pby - pay) * (pcx - pax);
      if (Math.abs(area) < 1e-9) continue;
      const invArea = 1 / area;
      for (let py = by0; py < by1; py++) {
        const sy = py + 0.5;
        for (let px = bx0; px < bx1; px++) {
          const sx = px + 0.5;
          const w0 = ((pbx - sx) * (pcy - sy) - (pby - sy) * (pcx - sx)) * invArea;
          const w1 = ((pcx - sx) * (pay - sy) - (pcy - sy) * (pax - sx)) * invArea;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const depth = w0 * da + w1 * db + w2 * dc;
          const zi = py * tileW + px;
          if (depth >= zbuf[zi]!) continue;
          zbuf[zi] = depth;
          const o = ((py * width) + tileX0 + px) * 4;
          data[o] = r; data[o + 1] = g; data[o + 2] = bl; data[o + 3] = 255;
        }
      }
    }
  }

  return { data, width, height, tileW, tileH, angleCount: N, worldWidth, worldHeight };
}

/**
 * CPU reference of the impostor shader's tile pick (T140) — exported so it is unit-testable without a GPU. Given
 * the camera + figure world XZ and the figure heading, returns the baked tile index nearest the LOCAL view azimuth
 * (camera direction rotated into the figure's frame, local +Z = the figure's front = world heading). MUST stay in
 * lockstep with `impostorUv`'s math. PURE + deterministic (V26).
 */
export function nearestImpostorTile(camX: number, camZ: number, figX: number, figZ: number, heading: number, angleCount: number): number {
  const dx = camX - figX;
  const dz = camZ - figZ;
  const ch = Math.cos(heading);
  const sh = Math.sin(heading);
  const lx = dx * sh - dz * ch;
  const lz = dx * ch + dz * sh;
  const phi = Math.atan2(lx, lz);
  const step = TAU / angleCount;
  const k = Math.floor(phi / step + 0.5);
  return ((k % angleCount) + angleCount) % angleCount;
}

interface ImpostorSlot {
  readonly key: ArchetypeKey;
  readonly mesh: InstancedMesh;
  readonly arr: Float32Array;
  readonly buf: InstancedInterleavedBuffer;
  readonly atlas: ImpostorAtlas;
  live: number;
}

/**
 * The far-band billboard impostor lane: one instanced quad per archetype sampling that archetype's baked yaw
 * atlas. Built lazily per archetype as GLBs attach (mirrors `RiggedCrowd`); `isReady` once all three are baked.
 * Construction is GPU-free; the atlas DataTexture + buffers upload on first render (V24). It consumes the SAME
 * distance band mask the rigged lane does (it draws exactly the slots NOT marked `BAND_RIGGED`), so every alive
 * zombie is claimed by exactly one lane (§B).
 */
export class CrowdImpostors {
  private readonly slots = new Map<ArchetypeKey, ImpostorSlot>();
  private readonly capacity: number;
  private readonly variationCount: number;
  private readonly scaleMin: number;
  private readonly scaleMax: number;
  private readonly brightnessSpread: number;
  private readonly angleCount: number;
  private readonly tileH: number;
  private readonly maxTriangles: number;
  private readonly heightMeters: number;

  constructor(
    settings: CrowdSettings,
    private readonly parent: Object3D,
    cfg: { angleCount: number; tileH: number; maxTriangles: number; heightMeters: number },
  ) {
    this.capacity = settings.capacity;
    this.variationCount = settings.variationCount;
    this.scaleMin = settings.scaleMin;
    this.scaleMax = settings.scaleMax;
    this.brightnessSpread = settings.brightnessSpread;
    this.angleCount = cfg.angleCount;
    this.tileH = cfg.tileH;
    this.maxTriangles = cfg.maxTriangles;
    this.heightMeters = cfg.heightMeters;
  }

  /** True once every archetype's atlas is baked — the impostor lane covers the whole far band then. */
  get isReady(): boolean {
    return ARCHETYPE_KEYS.every((k) => this.slots.has(k));
  }

  /**
   * Bake + attach one archetype's impostor atlas + instanced billboard (idempotent per key). Parents the quad
   * mesh under `parent` (the crowd root) so the scene wiring is unchanged. Tracks every GPU resource (V24).
   */
  bakeArchetype(key: ArchetypeKey, gltf: GLTF, track: TrackFn): void {
    if (this.slots.has(key)) return;
    const atlas = bakeImpostorAtlas(gltf, {
      angleCount: this.angleCount,
      tileH: this.tileH,
      maxTriangles: this.maxTriangles,
      heightMeters: this.heightMeters,
    });
    const tex = new DataTexture(atlas.data, atlas.width, atlas.height, RGBAFormat, UnsignedByteType);
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearFilter;
    tex.generateMipmaps = false;
    tex.flipY = false; // row 0 = feet (v=0 at the feet)
    tex.name = `crowd.impostor.${key}.atlas`;
    tex.needsUpdate = true;
    track(tex, 'texture', `crowd.impostor.${key}.atlasTex`);

    const geo = new PlaneGeometry(1, 1); // unit quad; sized + billboarded in the shader
    track(geo as unknown as Disposable, 'geometry', `crowd.impostor.${key}.geo`);
    const arr = new Float32Array(this.capacity * FLOATS_PER_INSTANCE);
    const buf = new InstancedInterleavedBuffer(arr, FLOATS_PER_INSTANCE);
    buf.setUsage(DynamicDrawUsage);
    geo.setAttribute('iImp', new InterleavedBufferAttribute(buf, 4, INST_POSE));
    geo.setAttribute('iImp2', new InterleavedBufferAttribute(buf, 4, INST_META));

    const material = new MeshBasicNodeMaterial({ name: `crowd.impostor.${key}` });
    material.transparent = true;
    material.alphaTest = 0.35; // crisp silhouette cut-out; reveal fade still rides in alpha below
    material.depthWrite = true;

    // Per-archetype CONSTANTS folded straight into the graph (they never change after bake) — avoids the
    // UniformNode typing churn and a per-frame uniform upload.
    const N = atlas.angleCount;
    const worldW = atlas.worldWidth;
    const worldH = atlas.worldHeight;
    const denom = Math.max(1, this.variationCount - 1);
    const spread = this.brightnessSpread;

    // Y-up cylindrical billboard + nearest-yaw tile pick. positionNode returns WORLD position (the mesh's
    // model+instance matrices are identity, mirroring the rigged lane), so the camera view-projection applies.
    material.positionNode = Fn(() => {
      const pose = attribute<'vec4'>('iImp', 'vec4'); // [px,py,pz,heading]
      const meta = attribute<'vec4'>('iImp2', 'vec4'); // [scale, seed, fade, _]
      const center = pose.xyz;
      const scale = meta.x;
      // Camera-to-figure horizontal direction → screen-right (Y-up billboard).
      const toCam = vec2(cameraPosition.x.sub(center.x), cameraPosition.z.sub(center.z)).normalize();
      const right = vec3(toCam.y, 0, toCam.x.negate());
      const up = vec3(0, 1, 0);
      const lx = positionLocal.x; // PlaneGeometry position.x ∈ [-0.5,0.5]
      const ly = positionLocal.y.add(0.5); // → [0,1], feet at 0
      const world = center
        .add(right.mul(lx.mul(worldW).mul(scale)))
        .add(up.mul(ly.mul(worldH).mul(scale)));
      return world;
    })();

    // Pick the baked tile nearest the LOCAL view azimuth (camera direction expressed in the figure's frame, where
    // local +Z is the figure's front = world heading), then sample the atlas; output colour×brightness, alpha×fade.
    material.colorNode = Fn(() => {
      const meta = attribute<'vec4'>('iImp2', 'vec4');
      const t = meta.y.div(denom);
      const brightness = float(1 - spread).add(t.mul(spread * 2));
      return texture(tex, impostorUv(N)).rgb.mul(brightness);
    })();
    material.opacityNode = Fn(() => {
      const meta = attribute<'vec4'>('iImp2', 'vec4');
      return texture(tex, impostorUv(N)).a.mul(meta.z);
    })();
    track(material as unknown as Disposable, 'material', `crowd.impostor.${key}.mat`);

    const inst = new InstancedMesh(geo, material, this.capacity);
    inst.count = 0;
    inst.frustumCulled = false;
    inst.castShadow = false; // far billboards don't cast (cheap; avoids flat-card shadow artifacts)
    inst.receiveShadow = false;
    inst.name = `crowd.impostor.${key}`;
    track(inst as unknown as Disposable, 'buffer', `crowd.impostor.${key}.mesh`);
    this.parent.add(inst);
    this.slots.set(key, { key, mesh: inst, arr, buf, atlas, live: 0 });
  }

  /** DEV/test-only (the crowd-test harness): the baked atlas for an archetype, for headless silhouette inspection. */
  debugAtlas(key: ArchetypeKey): ImpostorAtlas | undefined {
    return this.slots.get(key)?.atlas;
  }

  /** Hide every impostor (draw 0 instances) — pre-bake gap + when the impostor lane is otherwise inactive. */
  hide(): void {
    for (const slot of this.slots.values()) slot.mesh.count = 0;
  }

  /**
   * Pack the FAR-band live zombies (mask !== BAND_RIGGED) into their archetype's billboard buffer for this frame.
   * Reads the SAME distance mask the rigged lane consults (slots it did NOT claim) so every alive zombie is drawn
   * by exactly one lane (§B). Vision-cull-hidden members (fade<=0) are skipped; edge members fade via alpha (V65).
   * Returns the total drawn count. No-op (0) until every archetype is baked. Allocation-free per frame (V24).
   */
  update(views: FieldViews, count: number, visibility: VisionCull | undefined, mask: Uint8Array): number {
    if (!this.isReady) return 0;
    for (const slot of this.slots.values()) slot.live = 0;

    const alive = requireView<Uint8Array>(views, 'alive');
    const position = requireView<Float32Array>(views, 'position');
    const heading = requireView<Float32Array>(views, 'heading');
    const archetype = requireView<Uint16Array>(views, 'archetype');

    for (let s = 0; s < count; s++) {
      if (alive[s] === 0) continue;
      if (mask[s] === BAND_RIGGED) continue; // claimed by the rigged lane
      let fade = 1;
      if (visibility) {
        fade = visibility.reveal ? visibility.reveal[s]! : visionCullFade(position[s * 3]!, position[s * 3 + 2]!, visibility);
        if (fade <= 0) continue;
      }
      const slot = this.slots.get(archetypeKeyForIndex(archetype[s]!))!;
      if (slot.live >= this.capacity) continue;
      const seed = variationSeed(s, this.variationCount);
      const i = slot.live;
      const b = i * FLOATS_PER_INSTANCE;
      slot.arr[b + INST_POSE] = position[s * 3]!;
      slot.arr[b + INST_POSE + 1] = position[s * 3 + 1]!;
      slot.arr[b + INST_POSE + 2] = position[s * 3 + 2]!;
      slot.arr[b + INST_POSE + 3] = heading[s]!;
      slot.arr[b + INST_META] = variationScale(seed, this.variationCount, this.scaleMin, this.scaleMax);
      slot.arr[b + INST_META + 1] = seed;
      slot.arr[b + INST_META + 2] = fade;
      slot.arr[b + INST_META + 3] = 0;
      slot.live++;
    }

    let total = 0;
    for (const slot of this.slots.values()) {
      slot.buf.needsUpdate = true;
      slot.mesh.count = slot.live;
      total += slot.live;
    }
    return total;
  }
}

function requireView<T>(views: FieldViews, name: string): T {
  const v = views[name];
  if (!v) throw new Error(`SoA view '${name}' missing — impostor lane requires the frozen ZOMBIE_FIELDS layout`);
  return v as unknown as T;
}

/**
 * Atlas UV for the current vertex: pick the tile k nearest the LOCAL view azimuth (camera direction rotated into
 * the figure's frame, local +Z = the figure's front = world heading), then map the quad's local x into that tile.
 *   localDir = R(-heading)·(cam-figure)_xz ;  phi = atan2(localDir.x, localDir.z) ;  k = round(phi·N/τ) mod N
 *   u = (k + (localX+0.5)) / N ;  v = localY+0.5  (feet at v=0)
 */
function impostorUv(N: number): ReturnType<typeof vec2> {
  const pose = attribute<'vec4'>('iImp', 'vec4');
  const center = pose.xyz;
  const h = pose.w; // heading
  const dx = cameraPosition.x.sub(center.x);
  const dz = cameraPosition.z.sub(center.z);
  const ch = cos(h);
  const sh = sin(h);
  // local = R(-heading)·worldDir, with the rigged facing basis (local+Z → world heading): lx = dx·sin h − dz·cos h ;
  // lz = dx·cos h + dz·sin h.
  const lx = dx.mul(sh).sub(dz.mul(ch));
  const lz = dx.mul(ch).add(dz.mul(sh));
  const phi = atan(lx, lz); // atan2 — [-π,π], 0 when the camera is in front (local +Z)
  const step = TAU / N;
  // k = round(phi/step) wrapped into [0,N).
  const k = mod(floor(phi.div(step).add(0.5)).add(N), N);
  const u = k.add(positionLocal.x.add(0.5)).div(N);
  const v = positionLocal.y.add(0.5);
  return vec2(u, v);
}
