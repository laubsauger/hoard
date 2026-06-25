// T134 / V2 — ISOLATED ragdoll test harness. A reduced WebGPU scene with ONE rigged zombie you can KILL via a
// CDP/console hook and watch fall + settle, instead of playing the full game. It loads + bakes the three rigged
// zombie GLBs through the SAME path the game uses (`new RiggedCrowd(...)` + `attach(...)`), drives ONE live view
// through `crowd.update(...)` while standing and the corpse pool through `crowd.updateCorpses(...)` after the kill.
//
// Drive it from the page console / CDP:
//   window.__ragdoll.kill(dirX, dirZ, force)   // spawn a corpse at the standing transform + hand it to the sim
//   window.__ragdoll.reset()                   // back to standing, clear the corpse/ragdoll
//   window.__ragdoll.info()                    // { settled, bonePosCount, bbox, anyNaN } for headless assertions
//   window.__ragdollReady                      // true once all three archetypes baked + the first frame drew

import {
  AmbientLight,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RendererHost, createWebGpuBackendFactory } from '../render/engine';
import { RiggedCrowd, resolveRagdollConfig } from '../render/crowd/rigged';
import { resolveCrowdSettings } from '../render/crowd/crowd';
import { resolveCorpseFieldSettings } from '../render/corpse';
import { ARCHETYPE_KEYS, type ArchetypeKey } from '../render/crowd/riggedAnim';
import { ZOMBIE_FIELDS, allocateSoa, type FieldViews } from '../game/core/contracts/soa';
import { ZombieState } from '../game/simulation';
import type { Corpse } from '../game/zombie';
import { assetUrl } from '../assetUrl';
import type { QualityTier } from '../config/types';

interface RagdollInfo {
  settled: boolean;
  bonePosCount: number;
  bbox: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  anyNaN: boolean;
}

declare global {
  interface Window {
    __ragdoll?: {
      kill(dirX: number, dirZ: number, force: number): void;
      reset(): void;
      info(): RagdollInfo;
    };
    __ragdollReady?: boolean;
  }
}

const TIER: QualityTier = 'desktop-high';

async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('ragdoll-test: #view canvas missing');

  // ---- Renderer host (the SAME WebGPU engine boundary the game uses). ----
  const host = new RendererHost({ factory: createWebGpuBackendFactory({ canvas }), maxRecoveries: 1 });
  await host.init();
  const track = (res: Parameters<typeof host.resources.track>[0], kind: Parameters<typeof host.resources.track>[1], label: string) =>
    host.resources.track(res, kind, label);

  // ---- Scene: a lit ground plane at y=0 + a close camera angled slightly down so the body reads on the floor. ----
  const scene = new Scene();
  scene.background = new Color(0x14171a);

  const ground = new Mesh(
    new PlaneGeometry(40, 40),
    new MeshStandardMaterial({ color: 0x3b4038, roughness: 0.95, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  scene.add(new AmbientLight(0xffffff, 0.5));
  scene.add(new HemisphereLight(0xaebfce, 0x2a2620, 0.4));
  const key = new DirectionalLight(0xfff2dc, 2.4);
  key.position.set(3.5, 6, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 24;
  key.shadow.camera.left = -3;
  key.shadow.camera.right = 3;
  key.shadow.camera.top = 4;
  key.shadow.camera.bottom = -1;
  key.shadow.bias = -0.0004;
  key.target.position.set(0, 0.6, 0);
  scene.add(key, key.target);

  const camera = new PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(3.6, 2.7, 6.2); // angled 3/4 view down the knockback travel lane (origin → several m +Z)
  camera.lookAt(-0.2, 0.15, 1.7);

  const resize = (): void => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    host.setSize(w, h);
    host.setPixelRatio(1); // fixed ratio → deterministic screenshots
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);
  host.setToneMapping('aces', 1);

  // ---- The rigged crowd (one zombie). Bake all three archetypes so `isReady` (which gates update/updateCorpses). ----
  const crowdSettings = resolveCrowdSettings(TIER);
  const ragdollConfig = resolveRagdollConfig(TIER);
  const corpseCapacity = resolveCorpseFieldSettings(TIER).capacity;
  const parent = new Group();
  scene.add(parent);
  const crowd = new RiggedCrowd(crowdSettings, parent);

  const loader = new GLTFLoader();
  const urls: Record<ArchetypeKey, string> = {
    standard: assetUrl('meshes/zombie-standard.glb'),
    runner: assetUrl('meshes/zombie-runner.glb'),
    bloated: assetUrl('meshes/zombie-bloated.glb'),
  };
  await Promise.all(
    ARCHETYPE_KEYS.map(async (k) => {
      const gltf = await loader.loadAsync(urls[k]);
      crowd.attach(k, gltf, track, corpseCapacity, ragdollConfig);
    }),
  );

  // ---- ONE live standing zombie (a single SoA view). ----
  const soa = allocateSoa(ZOMBIE_FIELDS, 1);
  const views: FieldViews = soa.views;
  const alive = views.alive as Uint8Array;
  const position = views.position as Float32Array;
  const heading = views.heading as Float32Array;
  const state = views.state as Uint8Array;
  const archetype = views.archetype as Uint16Array;
  alive[0] = 1;
  position[0] = 0; position[1] = 0; position[2] = 0;
  heading[0] = Math.PI / 2; // face +Z toward the camera-ish so the front reads
  state[0] = ZombieState.Idle;
  archetype[0] = 0; // standard

  // ---- Corpse state driven by the window hook. A fresh entity id per kill → the sim seeds a fresh ragdoll. ----
  let entitySeq = 0;
  let activeCorpse: Corpse | null = null;
  const noCorpses: readonly Corpse[] = [];

  window.__ragdoll = {
    kill(dirX: number, dirZ: number, force: number): void {
      entitySeq += 1;
      const mag = Math.hypot(dirX, dirZ);
      const nx = mag > 1e-6 ? dirX / mag : 0;
      const nz = mag > 1e-6 ? dirZ / mag : 0;
      activeCorpse = {
        entity: entitySeq,
        x: position[0]!, y: position[1]!, z: position[2]!,
        heading: heading[0]!,
        archetype: 0,
        severedFlags: 0,
        bornTick: 0,
        impactDirX: nx,
        impactDirZ: nz,
        impactForce: force,
      };
      alive[0] = 0; // hide the live zombie — the corpse owns the body now
    },
    reset(): void {
      activeCorpse = null;
      alive[0] = 1;
    },
    info(): RagdollInfo {
      const empty: RagdollInfo = {
        settled: false,
        bonePosCount: 0,
        bbox: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 },
        anyNaN: false,
      };
      if (!activeCorpse) return empty;
      const rag = crowd.debugRagdoll(activeCorpse.entity);
      if (!rag) return empty;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      let anyNaN = false;
      for (let i = 0; i < rag.spec.bodyCount; i++) {
        const x = rag.c[i * 3]!, y = rag.c[i * 3 + 1]!, z = rag.c[i * 3 + 2]!;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) anyNaN = true;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      for (let i = 0; i < rag.q.length; i++) if (!Number.isFinite(rag.q[i]!)) anyNaN = true;
      for (let i = 0; i < rag.bones.length; i++) if (!Number.isFinite(rag.bones[i]!)) anyNaN = true;
      return { settled: rag.settled, bonePosCount: rag.spec.bodyCount, bbox: { minX, maxX, minY, maxY, minZ, maxZ }, anyNaN };
    },
  };

  // ---- Frame loop (real rAF, clamped dt). ----
  let last = performance.now();
  let drewOnce = false;
  const frame = (now: number): void => {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    crowd.update(views, 1, dt);
    crowd.updateCorpses(activeCorpse ? [activeCorpse] : noCorpses, dt);
    host.render(scene, camera);
    if (!drewOnce) {
      drewOnce = true;
      window.__ragdollReady = true;
      // eslint-disable-next-line no-console
      console.log('[ragdoll-test] ready — window.__ragdoll.kill(dx,dz,force) to fire');
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[ragdoll-test] init failed', err);
});
