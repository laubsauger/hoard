// T140 / V2 — ISOLATED crowd test harness. A reduced WebGPU scene that spawns a DENSE crowd (~200 zombies at a
// spread of distances + sim tiers + states) so a SINGLE screenshot reveals whether any BOX is on screen. It loads
// + bakes the three rigged zombie GLBs through the SAME path the game uses (`new Crowd(...)` + `crowd.rigged.attach`),
// then drives the normal `crowd.update(...)` loop. The whole point: near + mid zombies must be detailed RIGGED
// figures, the far ones recognizable zombie BILLBOARDS, and ZERO boxes anywhere.
//
// Drive it from the page console / CDP:
//   window.__crowd.setCount(n)            // respawn with n live zombies
//   window.__crowd.setCameraDistance(d)   // pull the camera back to distance d (m) from the horde centre
//   window.__crowd.info()                 // { rigged, impostor, corpse, total, anyBoxDrawn, frameMs, riggedMaxDistance }
//   window.__crowdReady                   // true once all three archetypes baked + the first frame drew

import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RendererHost, createWebGpuBackendFactory } from '../render/engine';
import { Crowd, resolveCrowdSettings } from '../render/crowd/crowd';
import { resolveRagdollConfig } from '../render/crowd/rigged';
import { resolveCorpseFieldSettings } from '../render/corpse';
import { ARCHETYPE_KEYS, type ArchetypeKey } from '../render/crowd/riggedAnim';
import { ZOMBIE_FIELDS, allocateSoa, type FieldViews } from '../game/core/contracts/soa';
import { ZombieState } from '../game/simulation';
import { assetUrl } from '../assetUrl';
import type { QualityTier } from '../config/types';

interface CrowdInfo {
  rigged: number;
  impostor: number;
  corpse: number;
  total: number;
  anyBoxDrawn: boolean;
  frameMs: number;
  riggedMaxDistance: number;
  liveCount: number;
}

declare global {
  interface Window {
    __crowd?: {
      setCount(n: number): void;
      setCameraDistance(d: number): void;
      setRiggedDistance(d: number): void;
      dumpAtlas(k: ArchetypeKey): string;
      info(): CrowdInfo;
    };
    __crowdReady?: boolean;
  }
}

const TIER: QualityTier = 'desktop-high';
/** SoA capacity for the test (well above the spawn count). */
const SOA_CAP = 512;
/** Archetype registry indices that have dedicated rigged GLBs (the rest reuse standard). */
const ARCH_INDICES = [0, 1, 6, 2, 3]; // standard, runner, bloated, + two that reuse standard

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('crowd-test: #view canvas missing');

  const host = new RendererHost({ factory: createWebGpuBackendFactory({ canvas }), maxRecoveries: 1 });
  await host.init();
  const track = (res: Parameters<typeof host.resources.track>[0], kind: Parameters<typeof host.resources.track>[1], label: string) =>
    host.resources.track(res, kind, label);

  const scene = new Scene();
  scene.background = new Color(0x14171a);
  scene.fog = new Fog(0x14171a, 90, 260);

  const ground = new Mesh(
    new PlaneGeometry(600, 600),
    new MeshStandardMaterial({ color: 0x33392f, roughness: 0.97, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  scene.add(new AmbientLight(0xffffff, 0.5));
  scene.add(new HemisphereLight(0xaebfce, 0x2a2620, 0.45));
  const key = new DirectionalLight(0xfff2dc, 2.2);
  key.position.set(40, 70, 50);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 260;
  key.shadow.camera.left = -120;
  key.shadow.camera.right = 120;
  key.shadow.camera.top = 120;
  key.shadow.camera.bottom = -120;
  key.shadow.bias = -0.0004;
  key.target.position.set(0, 0, -40);
  scene.add(key, key.target);

  const camera = new PerspectiveCamera(50, 1, 0.1, 600);
  const hordeCentre = { x: 0, z: -55 };
  let cameraDistance = 70;
  const placeCamera = (): void => {
    // Pull back along +z and up, looking at the horde centre, so a big swathe of the field is on screen.
    camera.position.set(hordeCentre.x, cameraDistance * 0.42, hordeCentre.z + cameraDistance);
    camera.lookAt(hordeCentre.x, 1.0, hordeCentre.z);
  };
  placeCamera();

  const resize = (): void => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    host.setSize(w, h);
    host.setPixelRatio(1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);
  host.setToneMapping('aces', 1);

  // ---- The crowd (Crowd: rigged near + impostor far). Bake all three archetypes. ----
  const settings = resolveCrowdSettings(TIER);
  const ragdollConfig = resolveRagdollConfig(TIER);
  const corpseCapacity = resolveCorpseFieldSettings(TIER).capacity;
  const crowd = new Crowd(settings);
  scene.add(crowd.mesh);

  const loader = new GLTFLoader();
  const urls: Record<ArchetypeKey, string> = {
    standard: assetUrl('meshes/zombie-standard.glb'),
    runner: assetUrl('meshes/zombie-runner.glb'),
    bloated: assetUrl('meshes/zombie-bloated.glb'),
  };
  await Promise.all(
    ARCHETYPE_KEYS.map(async (k) => {
      const gltf = await loader.loadAsync(urls[k]);
      crowd.rigged.attach(k, gltf, track, corpseCapacity, ragdollConfig);
    }),
  );

  // ---- A dense crowd: a wide field in front of the camera, distances 5..150 m, mixed archetypes/states/tiers. ----
  const soa = allocateSoa(ZOMBIE_FIELDS, SOA_CAP);
  const views: FieldViews = soa.views;
  const alive = views.alive as Uint8Array;
  const position = views.position as Float32Array;
  const heading = views.heading as Float32Array;
  const velocity = views.velocity as Float32Array;
  const state = views.state as Uint8Array;
  const archetype = views.archetype as Uint16Array;
  const simTier = views.simTier as Uint8Array;

  let liveCount = 0;
  // Deterministic PRNG so the layout is stable across runs/screenshots.
  let seed = 0x1234abcd;
  const rnd = (): number => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 100000) / 100000;
  };

  const states = [ZombieState.Idle, ZombieState.Wander, ZombieState.Pursue, ZombieState.Attack];
  const spawn = (n: number): void => {
    const count = Math.min(n, SOA_CAP);
    seed = 0x1234abcd;
    for (let i = 0; i < count; i++) {
      alive[i] = 1;
      // A wide field in front of the camera: depth 5..150 m (from z=+5 near to z=−140 far), spread ±55 m in x.
      const depth = 5 + (i / count) * 145;
      position[i * 3] = (rnd() - 0.5) * 110;
      position[i * 3 + 1] = 0;
      position[i * 3 + 2] = 10 - depth;
      heading[i] = rnd() * Math.PI * 2;
      const st = states[(Math.floor(rnd() * states.length)) % states.length]!;
      state[i] = st;
      const sp = st === ZombieState.Pursue ? 2.4 : st === ZombieState.Wander ? 1.0 : 0;
      velocity[i * 3] = Math.cos(heading[i]!) * sp;
      velocity[i * 3 + 1] = 0;
      velocity[i * 3 + 2] = Math.sin(heading[i]!) * sp;
      archetype[i] = ARCH_INDICES[Math.floor(rnd() * ARCH_INDICES.length)]!;
      simTier[i] = Math.floor(rnd() * 4) as 0 | 1 | 2 | 3;
    }
    for (let i = count; i < SOA_CAP; i++) alive[i] = 0;
    liveCount = count;
  };
  spawn(200);

  // ---- Window hooks for the headless driver. ----
  let lastFrameMs = 0;
  const countByPrefix = (prefix: string): number => {
    let total = 0;
    crowd.mesh.traverse((o: Object3D) => {
      const m = o as InstancedMesh;
      if ((m as { isInstancedMesh?: boolean }).isInstancedMesh && m.name.startsWith(prefix)) total += m.count;
    });
    return total;
  };
  const anyBoxDrawn = (): boolean => {
    let found = false;
    crowd.mesh.traverse((o: Object3D) => {
      const m = o as InstancedMesh;
      if ((m as { isInstancedMesh?: boolean }).isInstancedMesh && m.count > 0 && (m.geometry instanceof BoxGeometry)) found = true;
    });
    return found;
  };

  window.__crowd = {
    setCount(n: number): void { spawn(n); },
    setCameraDistance(d: number): void { cameraDistance = Math.max(10, d); placeCamera(); },
    // DEV-only: force the rigged→impostor cutoff so a LARGE impostor billboard can be inspected up close.
    setRiggedDistance(d: number): void { (crowd.settings as { riggedMaxDistance: number }).riggedMaxDistance = d; },
    // DEV-only: the baked silhouette atlas for an archetype as a PNG data URL (headless silhouette inspection).
    dumpAtlas(k: ArchetypeKey): string {
      const atlas = crowd.impostor.debugAtlas(k);
      if (!atlas) return '';
      const cv = document.createElement('canvas');
      cv.width = atlas.width; cv.height = atlas.height;
      const ctx = cv.getContext('2d')!;
      // Atlas row 0 = feet; flip vertically so the saved PNG shows the figure upright.
      const flipped = new Uint8ClampedArray(atlas.data.length);
      for (let row = 0; row < atlas.height; row++) {
        const src = row * atlas.width * 4;
        const dst = (atlas.height - 1 - row) * atlas.width * 4;
        flipped.set(atlas.data.subarray(src, src + atlas.width * 4), dst);
      }
      ctx.putImageData(new ImageData(flipped, atlas.width, atlas.height), 0, 0);
      return cv.toDataURL('image/png');
    },
    info(): CrowdInfo {
      const rigged = countByPrefix('crowd.rigged.');
      const impostor = countByPrefix('crowd.impostor.');
      const corpse = countByPrefix('corpse.rigged.');
      return {
        rigged,
        impostor,
        corpse,
        total: rigged + impostor,
        anyBoxDrawn: anyBoxDrawn(),
        frameMs: lastFrameMs,
        riggedMaxDistance: settings.riggedMaxDistance,
        liveCount,
      };
    },
  };

  // ---- Frame loop. The LOD anchor is the CAMERA XZ (distance bands align with the view). ----
  let last = performance.now();
  let drewOnce = false;
  const frame = (now: number): void => {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    const t0 = performance.now();
    crowd.update(views, liveCount, dt, camera.position.x, camera.position.z);
    host.render(scene, camera);
    lastFrameMs = performance.now() - t0;
    if (!drewOnce) {
      drewOnce = true;
      window.__crowdReady = true;
      // eslint-disable-next-line no-console
      console.log('[crowd-test] ready — window.__crowd.info()');
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[crowd-test] init failed', err);
});
