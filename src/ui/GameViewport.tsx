// T38 — the world viewport. React owns the <canvas> element (shell concern) and mounts the DIRECT
// Three.js engine via a ref (NOT R3F, §C). It NEVER reads per-frame world state back into React (V1):
// only the runtime's throttled snapshots reach the stores/HUD. This effect builds the real WebGPU
// renderer behind the isolated backend boundary, the city-block scene, the tactical camera rig, the
// authoritative GameRuntime, and runs a requestAnimationFrame loop (FixedClock.advance via runtime.update
// → interpolate → render). Input (WASD/mouse/click/keys) is routed through the runtime as validated
// intent. Everything is disposed on unmount via the resource registry (V24). The WebGPU path is guarded
// so a missing adapter reports cleanly and never crashes React.

import { useEffect, useRef } from 'react';
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
import { combatConfig } from '../config/domains/combat';
import { audioConfig } from '../config/domains/audio';
import { resolveDomain } from '../config/registry';
import type { QualityTier } from '../config/types';
import { BlockScene } from '../render/scene';
import { type FireIgnition } from '../render/effects/fireView';
import { SceneGizmos } from '../render/debug';
import { debugViewStore } from '../diagnostics/store';
import { createNoiseSnapshotGate, noiseViewStore } from '../stores/noiseView';
import { inventoryViewStore } from '../stores/inventoryView';
import { resolveRenderAccessibility, type RenderAccessibility } from '../render/accessibility';
import { GameRuntime } from '../game/runtime';
import { createGameRuntime } from './viewport/gameRuntime';
import { rayDistanceToWall } from '../game/scene';
import { InMemoryPersistenceAdapter, IndexedDbPersistenceAdapter, type PersistenceAdapter } from '../game/persistence';
import { sessionStore, simStepDt } from '../stores/session';
import { inputStore } from '../stores/input';
import { settingsStore, type SettingsState } from '../stores/settings';
import { GameAudio, resolveAudioOutTuning, type AudibleSound } from '../audio-out';

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
    let rafHandle = 0;
    let host: RendererHost | null = null;
    let scene: BlockScene | null = null;
    let runtime: GameRuntime;
    let adapter: PersistenceAdapter | undefined;
    const keys = new Set<string>();
    const aim = new AimRaycaster();
    let selfNoise = 0; // 0..1 player-produced noise, bumped on fire, decays each frame (HUD noise meter).
    const cleanups: (() => void)[] = [];

    const stats = createDevStats();
    if (stats) cleanups.push(() => stats.dom.remove());

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
      const audioCfg = resolveDomain(audioConfig, tier);
      const adp = makeAdapter();
      adapter = adp;

      // M2: a representative district (multiple streaming sectors with abstract populations, V13).
      runtime = createGameRuntime(tier, adp);
      runtime.spawnHorde(combat.gateZeroZombieCount, combat.gateZeroSpawnRadiusMeters);

      host = createRendererHost(canvas, tier);
      if (!(await startRendererHost(host, { onError, isCancelled: () => cancelled }))) return;

      // Accessibility (V29) resolved once + live-applied; shared by the scene and the gore views below.
      let access = accessibilityFromSettings(settingsStore.getState());
      scene = new BlockScene({
        runtime,
        tier,
        registry: host.resources,
        accessibility: access,
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

      // Live-apply accessibility changes from the settings panel into the running scene (V29 end-to-end).
      const unsubAccessibility = settingsStore.subscribe((s) => {
        access = accessibilityFromSettings(s);
        scene?.setAccessibility(access);
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
          bumpSelfNoise: () => { selfNoise = 1; },
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
          getRuntime: () => runtime,
          setRuntime: (r) => { runtime = r; },
          publishInventory,
        }),
      );

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
        // T50/V29: movement reads the rebindable keymap (defaults to WASD).
        const b = inputStore.getState().bindings;
        const f = (keys.has(b.moveUp) ? 1 : 0) - (keys.has(b.moveDown) ? 1 : 0);
        const r = (keys.has(b.moveRight) ? 1 : 0) - (keys.has(b.moveLeft) ? 1 : 0);
        x = fwdX * f + rightX * r;
        z = fwdZ * f + rightZ * r;
        return { x, z };
      };

      const frame = (): void => {
        if (cancelled) return;
        stats?.begin();
        const nowMs = performance.now();
        const dt = Math.min(0.1, (nowMs - last) / 1000);
        last = nowMs;

        // T49/V12: authoritative pause-gate + single-player slowdown. simStepDt returns 0 while paused (the
        // sim HALTS — not just the UI) and otherwise scales the real frame dt by the time-scale.
        const sess = sessionStore.getState();
        const stepDt = simStepDt(dt, sess.paused, sess.timeScale);
        if (stepDt > 0) {
          const mv = moveSpeedKeys();
          // Sprint lever (Shift by default): the runtime gates it on stamina + drains/regenerates the pool.
          // Sneak stance (Ctrl by default, V62): emits less footstep noise — sprint takes precedence in the runtime.
          const bindNow = inputStore.getState().bindings;
          const sprint = keys.has(bindNow.sprint);
          const sneak = keys.has(bindNow.sneak);
          if (mv.x !== 0 || mv.z !== 0) runtime.movePlayer(mv.x, mv.z, stepDt, sprint, sneak);
          const hit = aim.worldPoint(camera);
          if (hit) {
            const pp = runtime.player();
            runtime.aim(hit.x - pp.x, hit.z - pp.z);
          }
          runtime.update(stepDt);
        }

        const p = runtime.player();
        camera.setTarget(p.x, 0, p.z);
        // B7: drain the runtime's event queues and feed the visual stream into the combat-feedback gore
        // system BEFORE syncFrame ages/renders it (this path was previously never called — gore drained
        // nowhere). World events are not consumed by the viewport.
        const drained = runtime.pollEvents();
        scene?.ingestCombatEvents(drained.visual, camera.camera.position);
        // T75/T76: feed the SAME drained visual stream into the pooled blood + gib systems, then advance
        // their pure sims + mirror to the GPU (V2 event-driven; never feeds the sim). gore-intensity 0
        // fully suppresses + reduce-flashes thins (V29); distance simplifies (V8).
        const camPos = camera.camera.position;
        bloodView.consume(drained.visual, {
          cameraX: camPos.x,
          cameraY: camPos.y,
          cameraZ: camPos.z,
          goreIntensity: access.goreIntensity,
          reduceFlashes: access.feedback.reduceFlashes,
          playerX: p.x,
          playerZ: p.z,
        });
        gibView.consume(drained.visual, {
          cameraX: camPos.x,
          cameraY: camPos.y,
          cameraZ: camPos.z,
          goreIntensity: access.goreIntensity,
          reduceFlashes: access.feedback.reduceFlashes,
        });
        bloodView.update(dt);
        gibView.update(dt);
        // T108 — glass-shard bursts: drain glassShatter events (window smash via verb / shot / zombie) into shards.
        impactView.consume(drained.visual, { goreIntensity: access.goreIntensity, reduceFlashes: access.feedback.reduceFlashes });
        impactView.update(dt); // T80/T81 — advance spark burst + age bullet-hole/wound decals (V57); + shards (T108)
        weatherView.update(dt, runtime.weather, p.x, p.z); // precipitation: ramp + recycle, box follows the player
        // FIRE: map any new `fireIgnited` world facts (structural cell → nav cell → world centre, the same
        // mapping blockScene uses) into flame ignitions, then mirror the live burning set. `isRouteBurning`
        // is the sim's truth used to retire flames whose cell stopped burning. reduce-flashes damps flicker (V29).
        const fireIgnitions: FireIgnition[] = [];
        for (const ev of drained.world) {
          if (ev.kind !== 'fireIgnited') continue;
          const nav = runtime.scene.navCellForStructuralCell(ev.cell);
          const c = runtime.scene.cellCenter(nav);
          fireIgnitions.push({ cell: ev.cell, x: c.x, y: c.y, z: c.z });
        }
        // camPos = camera EYE (billboard facing); the player position is the LOD/light-selection focus (the
        // near-ortho eye sits ~100m+ away, so using it for distance would cull every fire).
        fireView.update(dt, fireIgnitions, (cell) => runtime.isRouteBurning(cell), camPos, { x: p.x, y: 0, z: p.z }, access.feedback.reduceFlashes);
        corpseField.update(runtime.corpses.list); // T55/B9 — mirror lingering corpses onto the instanced field
        // T60/V29: glow the NEAREST interactable in reach (hidden when none). Pulse is damped to a steady glow
        // when reduce-flashes / reduce-motion is set. The runtime gives the placed + sized box; the view only
        // positions/scales/colours it (V1/V2 — never reads world state back).
        highlightView.update(
          runtime.nearestInteractableHighlight(),
          dt,
          access.feedback.reduceFlashes || access.feedback.reduceMotion,
        );
        scene?.syncFrame(dt, camera.camera, debugViewStore.getState().flags);
        gizmos.update(
          runtime.zombies,
          debugViewStore.getState().flags,
          { x: p.x, z: p.z, heading: runtime.playerAim() },
          (qx, qz) =>
            runtime.stimulus
              .query(qx, qz, runtime.tick)
              .filter((h) => h.stimulus.kind === 'sound')
              .map((h) => ({ x: h.stimulus.x, z: h.stimulus.z, intensity: h.intensity, radius: h.stimulus.radius })),
          (qx, qz, heading, maxR) => rayDistanceToWall(runtime.scene, qx, qz, heading, maxR),
        );

        // HUD noise meter: ambient = total sound loudness reaching the player; self = player's own output,
        // decaying over ~1.5s. Throttled publish (V11) — the meter reads a narrow snapshot, not the field.
        selfNoise = Math.max(0, selfNoise - dt / 1.5);
        let ambient = 0;
        // Single read-only query of the sound stimuli reaching the player (V2): drives BOTH the HUD noise
        // meter AND the procedural audio layer — the stimulus carries the source class + attenuated level
        // the audio-out lane needs to voice impacts/glass/alarms/groans (the soundEmitted VisualEvent only
        // carries an id, so the field is the class-aware source of "what's audible").
        const audible: AudibleSound[] = [];
        for (const h of runtime.stimulus.query(p.x, p.z, runtime.tick)) {
          if (h.stimulus.kind !== 'sound') continue;
          ambient += h.intensity;
          audible.push({ id: h.stimulus.id as unknown as number, source: h.stimulus.source, x: h.stimulus.x, z: h.stimulus.z, reaching: h.intensity });
        }
        noiseGate.push({ ambient01: Math.min(1, ambient), self01: selfNoise });
        // Feed the drained audible set + live nearby horde count to the procedural audio output (silent
        // until a gesture resumes its context). Group bed + occasional groans scale with the count (V28).
        gameAudio.frame({ playerX: p.x, audible, hordeCount: runtime.nearbyHordeCount(audioCfg.outHordeProximityRadiusMeters), dtSeconds: dt });
        if (scene) {
          // B6: apply tone mapping + the interior/night-compensated exposure resolved by the scene.
          host?.setToneMapping(scene.toneMappingMode, scene.currentExposure);
          // Assemble per-instance crowd transforms + advance animation phase on the GPU (V2) before the
          // render reads them via the crowd material's positionNode. computeAsync is deprecated (r181);
          // the renderer is initialized, so host.compute() runs synchronously.
          host?.compute(scene.crowd.computeNode);
          host?.render(scene.scene, camera.camera);
        }

        stats?.end();
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
