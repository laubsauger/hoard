// T38 — the world viewport. React owns the <canvas> element (shell concern) and mounts the DIRECT
// Three.js engine via a ref (NOT R3F, §C). It NEVER reads per-frame world state back into React (V1):
// only the runtime's throttled snapshots reach the stores/HUD. This effect builds the real WebGPU
// renderer behind the isolated backend boundary, the city-block scene, the tactical camera rig, the
// authoritative GameRuntime, and runs a requestAnimationFrame loop (FixedClock.advance via runtime.update
// → interpolate → render). Input (WASD/mouse/click/keys) is routed through the runtime as validated
// intent. Everything is disposed on unmount via the resource registry (V24). The WebGPU path is guarded
// so a missing adapter reports cleanly and never crashes React.

import { useEffect, useRef } from 'react';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { assetUrl } from '../assetUrl';
import { bootSet, bootDone, BootAssetProgress } from '../boot/bootSplash';
import {
  RendererHost,
  detectQualityTier,
  applyTierOverride,
  type AdapterLimits,
} from '../render/engine';
import { createDevStats, createRendererHost, startRendererHost, attachResize } from './viewport/rendererHost';
import { createCameraController } from './viewport/cameraController';
import { createEngineHandle, type EngineHandle } from './viewport/engineHandle';
import { createEffectViews } from './viewport/effectViews';
import { AimRaycaster } from './viewport/aim';
import { registerInput } from './viewport/input';
import { startRenderLoop } from './viewport/renderLoop';
import { combatConfig } from '../config/domains/combat';
import { audioConfig } from '../config/domains/audio';
import { uiConfig } from '../config/domains/UI';
import { resolveDomain } from '../config/registry';
import type { QualityTier } from '../config/types';
import { BlockScene } from '../render/scene';
import { SceneGizmos } from '../render/debug';
import { createNoiseSnapshotGate, noiseViewStore } from '../stores/noiseView';
import { inventoryViewStore } from '../stores/inventoryView';
import { resolveRenderAccessibility, type RenderAccessibility } from '../render/accessibility';
import { GameRuntime } from '../game/runtime';
import { createGameRuntime } from './viewport/gameRuntime';
import { InMemoryPersistenceAdapter, IndexedDbPersistenceAdapter, type PersistenceAdapter } from '../game/persistence';
import { sessionStore } from '../stores/session';
import { settingsStore, type SettingsState } from '../stores/settings';
import { GameAudio, resolveAudioOutTuning } from '../audio-out';

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

// The engine handle the React shell uses to issue slice-level intent (save/load/modify/weather) lives
// with its factory; re-exported so the existing shell imports (`from './GameViewport'`) are unchanged.
export type { EngineHandle };

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
    let stopLoop: (() => void) | null = null;
    let host: RendererHost | null = null;
    let scene: BlockScene | null = null;
    let runtime: GameRuntime;
    let adapter: PersistenceAdapter | undefined;
    const keys = new Set<string>();
    const aim = new AimRaycaster();
    const selfNoise = { value: 0 }; // 0..1 player-produced noise, bumped on fire, decays each frame (HUD noise meter).
    const cleanups: (() => void)[] = [];

    const stats = createDevStats();
    if (stats) cleanups.push(() => stats.dom.remove());

    sessionStore.getState().setPhase('loading');

    void (async () => {
      const limits = await detectAdapterLimits();
      if (cancelled) return;
      if (!limits) {
        sessionStore.getState().setPhase('error');
        bootDone(); // drop the splash so the error message (behind it) is visible
        onError?.('WebGPU is not available in this browser (no GPU adapter). The engine cannot start.');
        return;
      }

      const detected = detectQualityTier(limits);
      const requested = settingsStore.getState().qualityTierOverride;
      const tier: QualityTier = requested ? applyTierOverride(detected, requested) : detected;

      const combat = resolveDomain(combatConfig, tier);
      const audioCfg = resolveDomain(audioConfig, tier);
      const ui = resolveDomain(uiConfig, tier);
      const adp = makeAdapter();
      adapter = adp;

      // M2: a representative district (multiple streaming sectors with abstract populations, V13).
      runtime = createGameRuntime(tier, adp);
      runtime.spawnHorde(combat.gateZeroZombieCount, combat.gateZeroSpawnRadiusMeters);
      runtime.spawnCaptiveZombie(); // T135: the lone zombie sealed in the starting house's back room (no-op if none)

      bootSet(0.4, 'Initializing renderer…');
      host = createRendererHost(canvas, tier);
      if (!(await startRendererHost(host, { onError, isCancelled: () => cancelled }))) {
        bootDone(); // renderer failed to start — drop the splash so its reported error is visible
        return;
      }

      // Accessibility (V29) resolved once + live-applied; shared by the scene and the gore views below.
      let access = accessibilityFromSettings(settingsStore.getState());
      scene = new BlockScene({
        runtime,
        tier,
        registry: host.resources,
        accessibility: access,
      });

      bootSet(0.5, 'Building world…');

      // Boot splash dismissal is gated on BOTH the world's first painted frame AND every GLB download settling
      // (resolved OR failed — never hangs on a missing model), so a first-time visitor sees the splash until the
      // full rigged scene is actually on screen, not a half-loaded one. A render that succeeds while a model 404s
      // still dismisses (allSettled), and the inline 30 s watchdog is the last-resort floor.
      let firstFrame = false;
      let assetsSettled = false;
      const maybeFinishBoot = (): void => {
        if (firstFrame && assetsSettled) {
          bootSet(1, 'Ready');
          bootDone();
        }
      };
      const glbProgress = new BootAssetProgress(0.5, 0.95, 'Loading models…');
      const glbLoads: Promise<unknown>[] = [];

      // T127: load the RIGGED player GLB ONCE, in the BACKGROUND. The scene built synchronously with an empty
      // avatar root, so the first frame never blocks on this ~7 MB asset; the SkinnedMesh + AnimationMixer swap
      // in when it resolves (cancellation-guarded). Every GLB GPU resource is tracked in the host registry for
      // disposal (V24). A failed load is reported (not silently swallowed) and leaves the avatar root empty.
      glbLoads.push(
        new GLTFLoader()
          .loadAsync(assetUrl('meshes/ranger.glb'), glbProgress.onProgress('ranger'))
          .then((gltf) => {
            if (cancelled || !scene) return;
            scene.attachPlayerAvatar(gltf);
          })
          .catch((err) => {
            console.error('[player] failed to load meshes/ranger.glb — avatar will not render', err);
          }),
      );

      // T128: load the three RIGGED zombie archetype GLBs in the BACKGROUND, in parallel, then bake each into a
      // bone-matrix animation texture + GPU-skinned InstancedMesh (BlockScene.attachZombieMesh). The crowd's near
      // band runs as the procedural limbed figures until ALL three attach, then switches to rigged (no gap). Each
      // load is cancellation-guarded; a failure is logged (the limbed fallback keeps drawing). GPU resources are
      // tracked for disposal (V24).
      for (const [key, url] of [
        ['standard', assetUrl('meshes/zombie-standard.glb')],
        ['runner', assetUrl('meshes/zombie-runner.glb')],
        ['bloated', assetUrl('meshes/zombie-bloated.glb')],
      ] as const) {
        glbLoads.push(
          new GLTFLoader()
            .loadAsync(url, glbProgress.onProgress(key))
            .then((gltf) => {
              if (cancelled || !scene) return;
              scene.attachZombieMesh(key, gltf);
            })
            .catch((err) => {
              console.error(`[crowd] failed to load ${url} — rigged ${key} zombies will not render`, err);
            }),
        );
      }

      void Promise.allSettled(glbLoads).then(() => {
        assetsSettled = true;
        maybeFinishBoot();
      });

      // Procedural WebAudio OUTPUT layer (NEW audio-out lane). Synthesized — no asset files. Created here
      // but SILENT until a user gesture resumes its AudioContext (autoplay policy, wired in onClick/onKeyDown
      // below). Three volume buses track the settings store live: master → {sfx, music}; 0 on a bus mutes
      // only that bus. Disposed on unmount (V24). It only READS the drained event/stimulus stream (V2).
      const gameAudio = new GameAudio(resolveAudioOutTuning(tier));
      const pushVolumes = (s: SettingsState) =>
        gameAudio.setVolumes({ master: s.masterVolume, sfx: s.sfxVolume, music: s.musicVolume });
      pushVolumes(settingsStore.getState());
      const unsubVolume = settingsStore.subscribe(pushVolumes);
      cleanups.push(unsubVolume);
      cleanups.push(() => gameAudio.dispose());

      // Live-apply accessibility + the fog toggle from the settings panel into the running scene (V29 end-to-end).
      scene?.setFogEnabled(settingsStore.getState().fogEnabled); // initial state (subscribe only fires on change)
      const unsubAccessibility = settingsStore.subscribe((s) => {
        access = accessibilityFromSettings(s);
        scene?.setAccessibility(access);
        scene?.setFogEnabled(s.fogEnabled);
      });
      cleanups.push(unsubAccessibility);

      // Dev-tools scene gizmos (perception/attack radii, FSM-state markers, sound field). Toggled via the
      // debug-flag store; the layer self-hides when no flag is set, so it is free in normal play.
      const ng = runtime.scene.navGrid;
      const gizmos = new SceneGizmos(tier, {
        width: ng.width,
        height: ng.height,
        cellSize: ng.settings.navCellSize,
        blocked: (cx, cy) => ng.isBlocked(ng.index(cx, cy)),
      });
      const noiseGate = createNoiseSnapshotGate(noiseViewStore, tier);
      cleanups.push(() => noiseViewStore.getState().clear());

      // T85: publish the runtime's REAL inventory into the view store + make the menu's transfers real
      // (route them through runtime.transferItem, then re-publish). `runtime` is reassigned on load — the
      // closures read the live binding, so looting stays correct across a reload.
      const publishInventory = (): void => inventoryViewStore.getState().setContainers(runtime.inventorySnapshot());
      publishInventory();
      inventoryViewStore.setState({
        transfer: (from, to, item) => {
          runtime.transferItem(from, to, item);
          publishInventory();
        },
      });
      cleanups.push(() => inventoryViewStore.getState().setContainers([]));
      scene.scene.add(gizmos.group);
      cleanups.push(() => {
        scene?.scene.remove(gizmos.group);
        gizmos.dispose();
      });

      // Render-lane effect views + their shared static-structure surface projector (FRAGILE — see module).
      const { bloodView, gibView, impactView, weatherView, fireView, highlightView, corpseField, surfaceProjector, firearmRangeMeters } =
        createEffectViews({ tier, registry: host.resources, scene, gizmosGroup: gizmos.group, getRuntime: () => runtime });

      const camera = createCameraController(canvas, tier);

      cleanups.push(attachResize(canvas, host, camera, tier));

      cleanups.push(
        registerInput({
          canvas,
          camera,
          aim,
          keys,
          gameAudio,
          scene,
          impactView,
          surfaceProjector,
          firearmRangeMeters,
          getRuntime: () => runtime,
          getAccess: () => access,
          bumpSelfNoise: () => { selfNoise.value = 1; },
        }),
      );

      sessionStore.getState().setPhase('playing');

      // expose the slice handle to the React shell (commands flow UI -> engine, V1).
      onReady?.(
        createEngineHandle({
          tier,
          adapter: adp,
          camera,
          scene,
          canvas,
          promptLayout: {
            anchorHeightMeters: ui.interactionPromptAnchorHeightMeters,
            offsetPx: ui.interactionPromptOffsetPx,
            marginPx: ui.interactionPromptMarginPx,
          },
          getRuntime: () => runtime,
          setRuntime: (r) => { runtime = r; },
          publishInventory,
        }),
      );

      // ---- frame loop: real dt -> runtime.update (fixed ticks) -> sync scene -> render (V12) ----
      stopLoop = startRenderLoop({
        isCancelled: () => cancelled,
        stats,
        host,
        scene,
        camera,
        aim,
        keys,
        views: { bloodView, gibView, impactView, weatherView, fireView, highlightView, corpseField, surfaceProjector, firearmRangeMeters },
        gizmos,
        noiseGate,
        gameAudio,
        hordeProximityRadiusMeters: audioCfg.outHordeProximityRadiusMeters,
        getRuntime: () => runtime,
        getAccess: () => access,
        selfNoise,
      });

      // First PAINTED frame: one rAF schedules into the loop, the second fires AFTER that frame rendered — the
      // moment the world is actually visible. Dismiss the boot splash once this AND the GLBs have settled.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (cancelled) return;
          firstFrame = true;
          // No bar bump here — the GLB byte-progress owns the bar so it reads honestly; this is purely the gate
          // ensuring we never dismiss before a frame actually painted. done() takes it to 100% once assets settle.
          maybeFinishBoot();
        }),
      );
    })();

    return () => {
      cancelled = true;
      stopLoop?.();
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
