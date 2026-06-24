// Phase 3 (GameViewport decomposition): the per-frame requestAnimationFrame loop for the viewport.
// Real dt → runtime.update (fixed ticks, pause-gated by simStepDt) → drain events → mirror them onto the
// render-lane effect views → syncFrame → gizmos → noise/audio publish → compute + render (V12). It reads
// per-frame world state ONLY to drive the renderer/HUD snapshot (V1) and never feeds the sim (V2).
//
// `runtime` and `access` are sampled ONCE per frame through their live accessors (the runtime binding is
// reassigned on reload; accessibility is live-applied) — both are stable within a synchronous frame.
// startRenderLoop returns a stop() that cancels the pending frame; the cancelled guard makes any
// already-scheduled frame a no-op after unmount.

import type Stats from 'stats.js';
import type { RendererHost, CameraRig } from '../../render/engine';
import type { BlockScene } from '../../render/scene';
import type { GameRuntime } from '../../game/runtime';
import type { GameAudio, AudibleSound } from '../../audio-out';
import type { RenderAccessibility } from '../../render/accessibility';
import type { SceneGizmos } from '../../render/debug';
import type { FireIgnition } from '../../render/effects/fireView';
import type { EffectViews } from './effectViews';
import type { AimRaycaster } from './aim';
import type { createNoiseSnapshotGate } from '../../stores/noiseView';
import { rayDistanceToWall } from '../../game/scene';
import { sessionStore, simStepDt } from '../../stores/session';
import { inputStore } from '../../stores/input';
import { debugViewStore } from '../../diagnostics/store';

const DEG2RAD = Math.PI / 180;

export interface RenderLoopContext {
  readonly isCancelled: () => boolean;
  readonly stats: Stats | null;
  readonly host: RendererHost;
  readonly scene: BlockScene;
  readonly camera: CameraRig;
  readonly aim: AimRaycaster;
  readonly keys: Set<string>;
  readonly views: EffectViews;
  readonly gizmos: SceneGizmos;
  readonly noiseGate: ReturnType<typeof createNoiseSnapshotGate>;
  readonly gameAudio: GameAudio;
  /** audio-out horde-bed proximity radius (the only audio-domain value the loop needs). */
  readonly hordeProximityRadiusMeters: number;
  /** Live runtime accessor (reassigned on reload). */
  readonly getRuntime: () => GameRuntime;
  /** Live accessibility accessor (live-applied from settings). */
  readonly getAccess: () => RenderAccessibility;
  /** Player-produced noise level (bumped on fire, decays each frame). Shared with the input handlers. */
  readonly selfNoise: { value: number };
}

/** Start the rAF frame loop; returns a stop() that cancels the pending frame. */
export function startRenderLoop(ctx: RenderLoopContext): () => void {
  const { isCancelled, stats, host, scene, camera, aim, keys, gizmos, noiseGate, gameAudio, hordeProximityRadiusMeters, getRuntime, getAccess, selfNoise } = ctx;
  const { bloodView, gibView, impactView, weatherView, fireView, highlightView, corpseField } = ctx.views;

  // ---- frame loop: real dt -> runtime.update (fixed ticks) -> sync scene -> render (V12) ----
  let last = performance.now();
  let rafHandle = 0;
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
    if (isCancelled()) return;
    stats?.begin();
    const nowMs = performance.now();
    const dt = Math.min(0.1, (nowMs - last) / 1000);
    last = nowMs;
    const runtime = getRuntime();
    const access = getAccess();

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
    scene.ingestCombatEvents(drained.visual, camera.camera.position);
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
    scene.syncFrame(dt, camera.camera, debugViewStore.getState().flags);
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
    selfNoise.value = Math.max(0, selfNoise.value - dt / 1.5);
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
    noiseGate.push({ ambient01: Math.min(1, ambient), self01: selfNoise.value });
    // Feed the drained audible set + live nearby horde count to the procedural audio output (silent
    // until a gesture resumes its context). Group bed + occasional groans scale with the count (V28).
    gameAudio.frame({ playerX: p.x, audible, hordeCount: runtime.nearbyHordeCount(hordeProximityRadiusMeters), dtSeconds: dt });
    // B6: apply tone mapping + the interior/night-compensated exposure resolved by the scene.
    host.setToneMapping(scene.toneMappingMode, scene.currentExposure);
    // Assemble per-instance crowd transforms + advance animation phase on the GPU (V2) before the
    // render reads them via the crowd material's positionNode. computeAsync is deprecated (r181);
    // the renderer is initialized, so host.compute() runs synchronously.
    host.compute(scene.crowd.computeNode);
    host.render(scene.scene, camera.camera);

    stats?.end();
    rafHandle = requestAnimationFrame(frame);
  };
  rafHandle = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(rafHandle);
}
