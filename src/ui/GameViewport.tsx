// T38 — the world viewport. React owns the <canvas> element (shell concern) and mounts the DIRECT
// Three.js engine via a ref (NOT R3F, §C). It NEVER reads per-frame world state back into React (V1):
// only the runtime's throttled snapshots reach the stores/HUD. This effect builds the real WebGPU
// renderer behind the isolated backend boundary, the city-block scene, the tactical camera rig, the
// authoritative GameRuntime, and runs a requestAnimationFrame loop (FixedClock.advance via runtime.update
// → interpolate → render). Input (WASD/mouse/click/keys) is routed through the runtime as validated
// intent. Everything is disposed on unmount via the resource registry (V24). The WebGPU path is guarded
// so a missing adapter reports cleanly and never crashes React.

import { useEffect, useRef } from 'react';
import { Plane, Raycaster, Vector2, Vector3 } from 'three';
import {
  RendererHost,
  createWebGpuBackendFactory,
  detectQualityTier,
  applyTierOverride,
  CameraRig,
  resolveCameraSettings,
  type AdapterLimits,
} from '../render/engine';
import { resolve } from '../config/spec';
import { renderingConfig } from '../config/domains/rendering';
import { combatConfig } from '../config/domains/combat';
import { resolveDomain } from '../config/registry';
import type { QualityTier } from '../config/types';
import { BlockScene } from '../render/scene';
import { resolveRenderAccessibility, type RenderAccessibility } from '../render/accessibility';
import { GameRuntime } from '../game/runtime';
import { buildCityDistrict } from '../game/scene';
import { InMemoryPersistenceAdapter, IndexedDbPersistenceAdapter, type PersistenceAdapter } from '../game/persistence';
import type { CommandId, EntityId, ModuleId } from '../game/core/contracts';
import type { WeatherProfile } from '../config/domains/weather';
import { sessionStore } from '../stores/session';
import { settingsStore, type SettingsState } from '../stores/settings';

/** Map the persisted accessibility settings onto the renderer's injected params (V29). */
function accessibilityFromSettings(s: SettingsState): RenderAccessibility {
  return resolveRenderAccessibility({
    goreIntensity: s.goreIntensity,
    outlineStrength: s.outlineStrength,
    targetHighlightStrength: s.targetHighlightStrength,
    cameraShakeScale: s.cameraShakeScale,
    reduceFlashes: s.reduceFlashes,
    motionReduction: s.motionReduction,
  });
}

const DEG2RAD = Math.PI / 180;

/** The engine handle the React shell uses to issue slice-level intent (save/load/modify/weather). */
export interface EngineHandle {
  save(): Promise<void>;
  load(): Promise<void>;
  breach(): void;
  board(): void;
  ignite(): void;
  rotate(dir: 1 | -1): void;
  zoom(delta: number): void;
  setWeather(profile: WeatherProfile): void;
  // M2 medium-term objective intents (V1 — issued as confirmAction commands).
  collectPart(): void;
  repairRadio(): void;
  advanceObjective(): void;
}

export interface GameViewportProps {
  onReady?: (handle: EngineHandle) => void;
  onError?: (message: string) => void;
}

function detectAdapterLimits(): Promise<AdapterLimits | null> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return Promise.resolve(null);
  return gpu
    .requestAdapter()
    .then((adapter) =>
      adapter
        ? {
            maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
            maxBufferSize: Number(adapter.limits.maxBufferSize),
            maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
          }
        : null,
    )
    .catch(() => null);
}

export function GameViewport({ onReady, onError }: GameViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let rafHandle = 0;
    let host: RendererHost | null = null;
    let scene: BlockScene | null = null;
    let runtime: GameRuntime;
    let adapter: PersistenceAdapter | undefined;
    const keys = new Set<string>();
    const ndc = new Vector2(0, 0);
    const raycaster = new Raycaster();
    const groundPlane = new Plane(new Vector3(0, 1, 0), 0);
    const aimPoint = new Vector3();
    let cmdSeq = 1;
    const cleanups: (() => void)[] = [];

    sessionStore.getState().setPhase('loading');

    void (async () => {
      const limits = await detectAdapterLimits();
      if (cancelled) return;
      if (!limits) {
        sessionStore.getState().setPhase('error');
        onError?.('WebGPU is not available in this browser (no GPU adapter). The engine cannot start.');
        return;
      }

      const detected = detectQualityTier(limits);
      const requested = settingsStore.getState().qualityTierOverride;
      const tier: QualityTier = requested ? applyTierOverride(detected, requested) : detected;

      const combat = resolveDomain(combatConfig, tier);
      const adp = makeAdapter();
      adapter = adp;

      // M2: a representative district (multiple streaming sectors with abstract populations, V13).
      const district = buildCityDistrict(tier);
      runtime = new GameRuntime({ tier, adapter: adp, scene: district.block, sectors: district.sectors });
      runtime.spawnHorde(combat.gateZeroZombieCount, combat.gateZeroSpawnRadiusMeters);

      host = new RendererHost({
        factory: createWebGpuBackendFactory({ canvas }),
        maxRecoveries: resolve(renderingConfig.deviceLossMaxRecoveries, tier),
      });
      try {
        await host.init();
      } catch (err) {
        if (cancelled) return;
        sessionStore.getState().setPhase('error');
        onError?.(`WebGPU renderer failed to initialise: ${(err as Error).message}`);
        return;
      }
      if (cancelled) {
        host.dispose();
        return;
      }

      scene = new BlockScene({
        runtime,
        tier,
        registry: host.resources,
        accessibility: accessibilityFromSettings(settingsStore.getState()),
      });
      // Live-apply accessibility changes from the settings panel into the running scene (V29 end-to-end).
      const unsubAccessibility = settingsStore.subscribe((s) => scene?.setAccessibility(accessibilityFromSettings(s)));
      cleanups.push(unsubAccessibility);

      const camera = new CameraRig(resolveCameraSettings(tier), canvas.clientWidth / Math.max(1, canvas.clientHeight));

      const resize = (): void => {
        const w = canvas.clientWidth || 1;
        const h = canvas.clientHeight || 1;
        host?.setSize(w, h);
        host?.setPixelRatio(Math.min(window.devicePixelRatio, resolve(renderingConfig.pixelRatioMax, tier)));
        camera.setAspect(w / h);
      };
      resize();
      window.addEventListener('resize', resize);
      cleanups.push(() => window.removeEventListener('resize', resize));

      // ---- input: WASD move, mouse aim, click fire, Q/E rotate, +/- zoom, B breach, R board ----
      const onKeyDown = (e: KeyboardEvent): void => {
        keys.add(e.code);
        if (e.code === 'KeyQ') camera.rotate(-1);
        if (e.code === 'KeyE') camera.rotate(1);
      };
      const onKeyUp = (e: KeyboardEvent): void => {
        keys.delete(e.code);
      };
      const onMouseMove = (e: MouseEvent): void => {
        const r = canvas.getBoundingClientRect();
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      };
      const aimWorldPoint = (): Vector3 | null => {
        raycaster.setFromCamera(ndc, camera.camera);
        return raycaster.ray.intersectPlane(groundPlane, aimPoint) ? aimPoint : null;
      };
      const onClick = (): void => {
        const hit = aimWorldPoint();
        const p = runtime.player();
        const dx = hit ? hit.x - p.x : Math.cos(runtime.playerAim());
        const dz = hit ? hit.z - p.z : Math.sin(runtime.playerAim());
        runtime.aim(dx, dz);
        runtime.fire(dx, dz, 'torsoUpper');
      };
      const onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        camera.setZoom(camera.state.zoom + Math.sign(e.deltaY) * 2);
      };
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      canvas.addEventListener('mousemove', onMouseMove);
      canvas.addEventListener('click', onClick);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      cleanups.push(() => window.removeEventListener('keydown', onKeyDown));
      cleanups.push(() => window.removeEventListener('keyup', onKeyUp));
      cleanups.push(() => canvas.removeEventListener('mousemove', onMouseMove));
      cleanups.push(() => canvas.removeEventListener('click', onClick));
      cleanups.push(() => canvas.removeEventListener('wheel', onWheel));

      sessionStore.getState().setPhase('playing');

      // expose the slice handle to the React shell (commands flow UI -> engine, V1).
      const nextCmd = (): CommandId => cmdSeq++ as unknown as CommandId;
      onReady?.({
        save: () => runtime.save(),
        load: async () => {
          const reloaded = buildCityDistrict(tier);
          const fresh = new GameRuntime({ tier, adapter: adp, scene: reloaded.block, sectors: reloaded.sectors });
          await fresh.loadFrom();
          runtime = fresh;
          scene?.rebindRuntime(fresh);
        },
        breach: () => {
          runtime.dispatch({ kind: 'modifyStructure', id: nextCmd(), module: runtime.scene.moduleId as ModuleId, cell: runtime.defaultBreachCell(), op: 'breach' });
        },
        board: () => {
          runtime.dispatch({ kind: 'modifyStructure', id: nextCmd(), module: runtime.scene.moduleId as ModuleId, cell: runtime.defaultBreachCell(), op: 'board' });
        },
        ignite: () => runtime.igniteRoute(runtime.defaultBreachCell()),
        rotate: (dir) => camera.rotate(dir),
        zoom: (delta) => camera.setZoom(camera.state.zoom + delta),
        setWeather: (profile) => runtime.setWeather(profile),
        collectPart: () => {
          runtime.dispatch({ kind: 'confirmAction', id: nextCmd(), entity: runtime.playerEntity as EntityId, action: 'objective.collectPart' });
        },
        repairRadio: () => {
          runtime.dispatch({ kind: 'confirmAction', id: nextCmd(), entity: runtime.playerEntity as EntityId, action: 'objective.repair' });
        },
        advanceObjective: () => {
          runtime.dispatch({ kind: 'confirmAction', id: nextCmd(), entity: runtime.playerEntity as EntityId, action: 'objective.advance' });
        },
      });

      // ---- frame loop: real dt -> runtime.update (fixed ticks) -> sync scene -> render (V12) ----
      let last = performance.now();
      const moveSpeedKeys = (): { x: number; z: number } => {
        const yaw = camera.state.yawDeg * DEG2RAD;
        const fwdX = -Math.sin(yaw);
        const fwdZ = -Math.cos(yaw);
        const rightX = Math.cos(yaw);
        const rightZ = -Math.sin(yaw);
        let x = 0;
        let z = 0;
        const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
        const r = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
        x = fwdX * f + rightX * r;
        z = fwdZ * f + rightZ * r;
        return { x, z };
      };

      const frame = (): void => {
        if (cancelled) return;
        const nowMs = performance.now();
        const dt = Math.min(0.1, (nowMs - last) / 1000);
        last = nowMs;

        const mv = moveSpeedKeys();
        if (mv.x !== 0 || mv.z !== 0) runtime.movePlayer(mv.x, mv.z, dt);
        const hit = aimWorldPoint();
        if (hit) {
          const p = runtime.player();
          runtime.aim(hit.x - p.x, hit.z - p.z);
        }

        runtime.update(dt);

        const p = runtime.player();
        camera.setTarget(p.x, 0, p.z);
        scene?.syncFrame(dt, camera.camera);
        if (scene) host?.render(scene.scene, camera.camera);

        rafHandle = requestAnimationFrame(frame);
      };
      rafHandle = requestAnimationFrame(frame);
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafHandle);
      for (const c of cleanups) c();
      scene?.dispose();
      host?.dispose(); // disposeAll() on the registry frees crowd + block geometries/materials (V24)
      void adapter?.close();
      sessionStore.getState().setPhase('menu');
    };
  }, [onReady, onError]);

  return <canvas ref={canvasRef} className="hbn-viewport" tabIndex={0} />;
}

/** IndexedDB in the browser; an in-memory adapter where IndexedDB is unavailable (no silent data loss). */
function makeAdapter(): PersistenceAdapter {
  try {
    return new IndexedDbPersistenceAdapter();
  } catch {
    return new InMemoryPersistenceAdapter();
  }
}
