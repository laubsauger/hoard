// T38 — the world viewport. React owns the <canvas> element (shell concern) and mounts the DIRECT
// Three.js engine via a ref (NOT R3F, §C). It NEVER reads per-frame world state back into React (V1):
// only the runtime's throttled snapshots reach the stores/HUD. This effect builds the real WebGPU
// renderer behind the isolated backend boundary, the city-block scene, the tactical camera rig, the
// authoritative GameRuntime, and runs a requestAnimationFrame loop (FixedClock.advance via runtime.update
// → interpolate → render). Input (WASD/mouse/click/keys) is routed through the runtime as validated
// intent. Everything is disposed on unmount via the resource registry (V24). The WebGPU path is guarded
// so a missing adapter reports cleanly and never crashes React.

import { useEffect, useRef } from 'react';
import { Mesh, Plane, Raycaster, Vector2, Vector3, type BufferGeometry, type Material, type Object3D } from 'three';
import Stats from 'stats.js';
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
import { weaponsConfig } from '../config/domains/weapons';
import { resolveDomain } from '../config/registry';
import type { QualityTier } from '../config/types';
import { BlockScene } from '../render/scene';
import { BloodView, resolveBloodSettings } from '../render/effects/bloodView';
import { RaycastSurfaceProjector } from '../render/effects/surfaceProjector';
import { ImpactView, resolveImpactSettings, type ImpactIngestContext } from '../render/effects/impactView';
import { GibView, resolveGibSettings } from '../render/effects/gibView';
import { WeatherView, resolveRainSettings } from '../render/effects/weatherView';
import { FireView, resolveFireSettings, type FireIgnition } from '../render/effects/fireView';
import { CorpseField, resolveCorpseFieldSettings } from '../render/corpse';
import { SceneGizmos } from '../render/debug';
import { debugViewStore } from '../diagnostics/store';
import { createNoiseSnapshotGate, noiseViewStore } from '../stores/noiseView';
import { inventoryViewStore } from '../stores/inventoryView';
import { resolveRenderAccessibility, type RenderAccessibility } from '../render/accessibility';
import { GameRuntime } from '../game/runtime';
import { buildCityDistrict, rayDistanceToWall } from '../game/scene';
import type { InteractionPrompt, InteractionTargetWorld } from '../game/interaction';
import { InMemoryPersistenceAdapter, IndexedDbPersistenceAdapter, type PersistenceAdapter } from '../game/persistence';
import type { CommandId, EntityId, ModuleId } from '../game/core/contracts';
import type { WeatherProfile } from '../config/domains/weather';
import { sessionStore, simStepDt } from '../stores/session';
import { inputStore, formatKeyCode } from '../stores/input';
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

/**
 * Dev-only real-time perf meter (FPS / frame-ms / heap) over the live WebGPU frame loop. Established
 * stats.js panel, mounted top-right; click the panel to cycle FPS↔MS↔MB. Never ships to players
 * (gated on `import.meta.env.DEV`). True GPU-timestamp timing needs the engine to expose its
 * `WebGPURenderer`; until then this measures the real per-frame wall-clock of update+compute+render.
 */
function createDevStats(): Stats | null {
  if (!import.meta.env.DEV) return null;
  const stats = new Stats();
  stats.showPanel(0); // 0 = fps, 1 = ms, 2 = mb
  const dom = stats.dom;
  // z-index BELOW the UI modals (HUD 20 / pause 60 / settings 80) so the dev meter never overlaps a panel's
  // controls (e.g. the settings close button, top-right). Visible during play; any open modal covers it.
  dom.style.cssText = 'position:fixed;top:8px;right:8px;left:auto;z-index:15;cursor:pointer;';
  document.body.appendChild(dom);
  return stats;
}

/** The engine handle the React shell uses to issue slice-level intent (save/load/modify/weather). */
export interface EngineHandle {
  save(): Promise<void>;
  load(): Promise<void>;
  breach(): void;
  board(): void;
  ignite(): void;
  /** T46/T60: toggle the door NEAREST the player (open↔closed). No-op when none is in reach. */
  toggleNearestDoor(): void;
  /** T60: the "{key} to {action}" prompt for the nearest interactable in reach, or null (HUD polls this). */
  nearestInteraction(): InteractionPrompt | null;
  /** T60: the nearest interactable target (full state) — the wheel resolves its context verbs. */
  nearestInteractable(): InteractionTargetWorld | null;
  /** T59: open a world container's loot panel (the "Search/Loot" verb for a storage target). */
  loot(): void;
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

      // Accessibility (V29) resolved once + live-applied; shared by the scene and the gore views below.
      let access = accessibilityFromSettings(settingsStore.getState());
      scene = new BlockScene({
        runtime,
        tier,
        registry: host.resources,
        accessibility: access,
      });

      // T75/T76 (V51/V52): pooled BLOOD (arcing droplets -> drying directional floor decals + bloody
      // footsteps) + GIB (flung faceted meat chunks) systems. Event-driven (V2), pooled + capped (V24),
      // r184 binding-safe (V33). They SUPERSEDE the basic combat-feedback blood spray (now retired there).
      // Resources are tracked in the host registry so host.dispose() frees them on unmount (V24).
      const bloodView = new BloodView(resolveBloodSettings(tier), host.resources);
      const gibView = new GibView(resolveGibSettings(tier), host.resources);
      // T80/T81 (V57): DISTINCT, clearly NON-RED structure-impact response — a spark burst + persistent
      // bullet-hole decal on a WALL hit, and dark wound marks on struck BODIES — so a wall hit / clean miss
      // never reads like "blood beyond range". Wired directly here (NOT via blockScene.fireFeedback) like
      // blood/gib; the ShotResult branch in onClick decides wall (spark+hole) vs body (wound). Pooled+capped,
      // tracked in the registry for disposal (V24).
      const impactView = new ImpactView(resolveImpactSettings(tier), host.resources);
      // Precipitation atmosphere (RENDER lane WeatherView): instanced rain streaks in a camera-following box,
      // ramped in/out per the active weather profile (gated off in clear). Reads the runtime's weather each
      // frame; the existing fog/grade (blockScene/lighting) is untouched. Resources tracked → freed on unmount.
      const weatherView = new WeatherView(resolveRainSettings(tier), host.resources);
      // FIRE visuals (RENDER lane FireView): additive billboard flame columns + a pooled flickering light set
      // + faint smoke at the cells the sim reports burning. Pure visual mirror (V2) — fed the drained
      // `fireIgnited` WorldEvents (mapped to world positions) + the runtime's live `isRouteBurning` truth each
      // frame; never touches the sim. Resources tracked → freed on unmount (V24).
      const fireView = new FireView(resolveFireSettings(tier), host.resources);
      bloodView.attachTo(scene.scene);
      gibView.attachTo(scene.scene);
      impactView.attachTo(scene.scene);
      weatherView.attachTo(scene.scene);
      fireView.attachTo(scene.scene);

      // Procedural WebAudio OUTPUT layer (NEW audio-out lane). Synthesized — no asset files. Created here
      // but SILENT until a user gesture resumes its AudioContext (autoplay policy, wired in onClick/onKeyDown
      // below). Master volume tracks the settings store live; volume 0 also mutes the master node. Disposed
      // on unmount (V24). It only READS the drained event/stimulus stream — never feeds the sim (V2).
      const gameAudio = new GameAudio(resolveAudioOutTuning(tier));
      gameAudio.setMasterVolume(settingsStore.getState().masterVolume);
      gameAudio.setMuted(settingsStore.getState().masterVolume <= 0);
      const unsubVolume = settingsStore.subscribe((s) => {
        gameAudio.setMasterVolume(s.masterVolume);
        gameAudio.setMuted(s.masterVolume <= 0);
      });
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
      inventoryViewStore.getState().setOpenContainer('Kitchen Cupboard');
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

      // T77/V54: give the pooled BLOOD system a render-side surface projector so landing droplets project
      // onto the REAL structure — interior floor slabs (which sit above the street, the indoors fix) at
      // their true height + walls behind a struck body for vertical splats. The projector raycasts ONLY the
      // static structure meshes: we assemble that list by EXCLUDING the dynamic objects — the crowd
      // (scene.crowd.mesh), the player avatar (the scene's only CapsuleGeometry → its whole group), the
      // gizmo overlay, and every gore/effect mesh (blood./gib./combat. material names). Structure never
      // moves, so the list is built once. Read-only (V2); raycasts are bounded by the sim (per hit, pooled).
      const structures: Object3D[] = [];
      {
        const sceneRoot = scene.scene;
        const exclude = new Set<Object3D>();
        scene.crowd.mesh.traverse((o) => exclude.add(o)); // crowd box + its limbed-figure children (T72) are dynamic, not blood surfaces
        gizmos.group.traverse((o) => exclude.add(o));
        sceneRoot.traverse((o) => {
          const m = o as Mesh;
          if (m.isMesh && (m.geometry as BufferGeometry | undefined)?.type === 'CapsuleGeometry') {
            (m.parent ?? m).traverse((c) => exclude.add(c));
          }
        });
        sceneRoot.traverse((o) => {
          const m = o as Mesh;
          if (!m.isMesh || exclude.has(o)) return;
          const matName = (m.material as Material | undefined)?.name ?? '';
          if (matName.startsWith('blood.') || matName.startsWith('gib.') || matName.startsWith('impact.') || matName.startsWith('combat.')) return;
          structures.push(o);
        });
      }
      // One read-only surface projector over the static structures, shared by the blood floor/wall projector
      // (T77/V54) and the impact wall-finder (T80/V57). Structure never moves → built once (V2 read-only).
      const surfaceProjector = new RaycastSurfaceProjector(structures);
      bloodView.sim.setProjector(surfaceProjector);
      // Firearm range = the clean-miss tracer length. stopDistance < range ⇒ the shot stopped on structure
      // (a wall), not a clean miss to max range — that is the STRUCTURE-impact branch (V57). Range carries no
      // tier overrides, so resolving at the render tier matches the sim's authoritative value.
      const firearmRangeMeters = resolveDomain(weaponsConfig, tier).firearmRangeMeters;

      // T55/B9: pooled instanced CORPSE field — mirrors the runtime's lingering corpses (killed bodies do not
      // vanish). Attached AFTER the static-structure list is assembled so it is never treated as a blood
      // projection surface. Resources tracked in the host registry → freed on unmount (V24).
      const corpseField = new CorpseField(resolveCorpseFieldSettings(tier), host.resources);
      corpseField.attachTo(scene.scene);

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
        gameAudio.resume(); // autoplay policy: lazily create/resume the AudioContext on a user gesture.
        keys.add(e.code);
        // T50/V29: read the rebindable keymap so remapped rotate/pause keys take effect live.
        const b = inputStore.getState().bindings;
        if (e.code === b.rotateCCW) camera.rotate(-1);
        if (e.code === b.rotateCW) camera.rotate(1);
        if (e.code === b.pause) {
          // T49: the pause key toggles an authoritative pause — the sim HALTS in the frame loop (V12-safe)
          // and the pause menu shows. The session `paused` flag is the single source of truth shared with
          // the loop (the menu's Resume writes it too). Pausing leaves the lifecycle phase on 'playing'.
          if (sessionStore.getState().phase === 'playing') sessionStore.getState().togglePause();
        }
        // T74: reload (R) + cycle weapon ([ / ]). Direct keys for the prototype (rebindable bindings later).
        if (e.code === 'KeyR') runtime.reloadWeapon();
        if (e.code === 'BracketRight') runtime.cycleWeapon(1);
        if (e.code === 'BracketLeft') runtime.cycleWeapon(-1);
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
        gameAudio.resume(); // autoplay policy: a click is a valid gesture to start audio.
        gameAudio.gunshot(); // procedural gunshot synthesized directly off the player-fire path.
        const hit = aimWorldPoint();
        const p = runtime.player();
        const dx = hit ? hit.x - p.x : Math.cos(runtime.playerAim());
        const dz = hit ? hit.z - p.z : Math.sin(runtime.playerAim());
        runtime.aim(dx, dz);
        const shot = runtime.fire(dx, dz, 'torsoUpper');
        selfNoise = 1; // a gunshot is the loudest thing the player produces (HUD noise meter).
        // Pass the authoritative stop distance (struck body or first wall) so the tracer terminates there and
        // never draws through a wall on a miss into structure (V49/V53/B20).
        scene?.fireFeedback(dx, dz, shot.stopDistanceMeters); // B7: muzzle flash + tracer + report on fire
        // T80/T81 (V57): DISTINCT surface response, branched off the authoritative ShotResult.
        //   hit === true  → a zombie was struck → blood already fires (bloodView); add a WOUND mark at the
        //                   struck body point. NO wall spark.
        //   hit === false → clean miss / structure stop. When the shot stopped SHORT of weapon range it hit a
        //                   WALL → raycast the structures along the aim to the real surface → SPARK burst
        //                   (out of the wall) + bullet HOLE. A clean miss to max range hits nothing → no spark.
        const impactCtx: ImpactIngestContext = { goreIntensity: access.goreIntensity, reduceFlashes: access.feedback.reduceFlashes };
        const len = Math.hypot(dx, dz) || 1;
        const ndx = dx / len;
        const ndz = dz / len;
        const stop = shot.stopDistanceMeters ?? firearmRangeMeters;
        if (shot.hit) {
          // Struck body point = muzzle origin + aim*travel (XZ); region->height lifts it; the wound faces back
          // toward the shooter (-aim). Zombie base sits on the ground (y=0).
          const wx = p.x + ndx * stop;
          const wz = p.z + ndz * stop;
          impactView.wound(wx, 0, wz, shot.region ?? 'torsoUpper', -ndx, -ndz, impactCtx);
        } else if (stop < firearmRangeMeters) {
          // Structure stop: find the real wall surface the nav-grid blocker corresponds to (raycast to range
          // and take the first structure face), then spark + hole there oriented to its normal.
          const wh = surfaceProjector.wallAlong(p.x, p.y, p.z, ndx, ndz, firearmRangeMeters);
          if (wh) impactView.structureImpact(wh.x, wh.y, wh.z, wh.nx, wh.ny, wh.nz, impactCtx);
        }
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
          publishInventory(); // re-surface the reloaded runtime's inventory (T85)
        },
        breach: () => {
          runtime.dispatch({ kind: 'modifyStructure', id: nextCmd(), module: runtime.scene.moduleId as ModuleId, cell: runtime.defaultBreachCell(), op: 'breach' });
        },
        board: () => {
          runtime.dispatch({ kind: 'modifyStructure', id: nextCmd(), module: runtime.scene.moduleId as ModuleId, cell: runtime.defaultBreachCell(), op: 'board' });
        },
        ignite: () => runtime.igniteRoute(runtime.defaultBreachCell()),
        toggleNearestDoor: () => { runtime.toggleNearestDoor(); },
        nearestInteraction: () => runtime.nearestInteractionPrompt(formatKeyCode(inputStore.getState().bindings.interact)),
        nearestInteractable: () => runtime.nearestInteractableTarget(),
        loot: () => inventoryViewStore.getState().setOpenContainer('Kitchen Cupboard'),
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
          const sprint = keys.has(inputStore.getState().bindings.sprint);
          if (mv.x !== 0 || mv.z !== 0) runtime.movePlayer(mv.x, mv.z, stepDt, sprint);
          const hit = aimWorldPoint();
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
        impactView.update(dt); // T80/T81 — advance spark burst + age bullet-hole/wound decals (V57)
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
        scene?.syncFrame(dt, camera.camera);
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
        gameAudio.frame({ playerX: p.x, audible, hordeCount: runtime.zombies.count, dtSeconds: dt });
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
