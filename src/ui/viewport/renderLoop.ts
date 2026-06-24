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
import { uiStore } from '../../stores/ui';
import { inventoryViewStore } from '../../stores/inventoryView';
import { timeOfDayStore } from '../../stores/timeOfDay';

const DEG2RAD = Math.PI / 180;
/** Shared empty corpse list (T131/V99) — fed to the blob CorpseField once the rigged corpse layer owns the pool,
 *  so the fallback draws 0 without a per-frame allocation (V24). */
const EMPTY_CORPSES: never[] = [];

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
  const { bloodView, gibView, impactView, weatherView, fireView, highlightView, cursorView, corpseField } = ctx.views;

  // ---- frame loop: real dt -> runtime.update (fixed ticks) -> sync scene -> render (V12) ----
  let last = performance.now();
  let rafHandle = 0;
  // T126: only re-publish the HUD time-of-day when the displayed MINUTE changes (a full day = dayLengthSeconds,
  // so this fires a couple of times a second at most) — avoids a per-frame store write + React churn (V11).
  let lastTodMinute = -1;
  // Play a player pain GRUNT on each fresh damage hit — compares the sim's last-damage tick frame-over-frame
  // (the same signal the avatar hit-reaction reads), so one grunt per hit, never per frame.
  let lastGruntDamageTick = -1;
  // Play the RELOAD sample on the rising edge of the weapon's reloading state — covers BOTH a manual reload (R)
  // AND an automatic reload (the mag emptied), with no per-call-site wiring.
  let lastReloading = false;
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
    // T127: the player-avatar animation signals — move INTENT magnitude + the sprint key this frame. Gated to
    // false while paused (stepDt === 0) so a halted player idles, never walks/runs in place. Set in the sim block.
    let avatarMoving = false;
    let avatarSprinting = false;
    if (stepDt > 0) {
      const mv = moveSpeedKeys();
      // Sprint lever (Shift by default): the runtime gates it on stamina + drains/regenerates the pool.
      // Sneak stance (Ctrl by default, V62): emits less footstep noise — sprint takes precedence in the runtime.
      const bindNow = inputStore.getState().bindings;
      const sprint = keys.has(bindNow.sprint);
      const sneak = keys.has(bindNow.sneak);
      avatarMoving = mv.x !== 0 || mv.z !== 0;
      avatarSprinting = sprint;
      // V86: publish the CROUCH stance every frame (even when standing still) so the player eye height — which
      // drives both what the player sees over AND whether a crouched player is hidden behind low cover — tracks
      // the held key. Sprint takes precedence (you cannot sprint crouched).
      runtime.setCrouch(sneak && !sprint);
      if (mv.x !== 0 || mv.z !== 0) runtime.movePlayer(mv.x, mv.z, stepDt, sprint, sneak);
      // T136: while a UI panel is open (inventory/loot/settings/…), the mouse belongs to the UI — DON'T turn the
      // character to follow the cursor (so moving the mouse onto the pane no longer spins the avatar / re-aims).
      if (uiStore.getState().activePanel === 'none') {
        const hit = aim.worldPoint(camera);
        if (hit) {
          const pp = runtime.player();
          runtime.aim(hit.x - pp.x, hit.z - pp.z);
        }
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
    // T55/B9 — corpses. T131/V99: once the rigged corpse layer is live (all archetype GLBs baked in, driven by
    // BlockScene.syncFrame), the blob CorpseField stops drawing (empty list → count 0) so the two never double-draw;
    // before that it is the no-gap fallback, toppling each body by tick age (T122).
    corpseField.update(scene.riggedCorpsesActive() ? EMPTY_CORPSES : runtime.corpses.list, runtime.absoluteTick);
    // T136: while a UI panel is open the mouse drives the UI — FREEZE the world pointer (the active interactable
    // selection HOLDS at its last value, so the loot/wheel target can't drift while you operate the pane) and
    // hide the world reticle (the OS cursor handles the UI). Otherwise publish the pointer ground point so the
    // runtime HOVER-picks WHICH in-reach interactable is active (the mouse chooses among adjacent targets).
    const uiCaptures = uiStore.getState().activePanel !== 'none';
    const pointerHit = uiCaptures ? null : aim.worldPoint(camera);
    const pointer = pointerHit ? { x: pointerHit.x, z: pointerHit.z } : null;
    if (!uiCaptures) runtime.setPointerWorld(pointer); // panel open → skip → the runtime holds its last selection
    // T60/V29: glow the ACTIVE interactable in reach (hidden when none) — the one under the cursor, else nearest.
    // Pulse is damped to a steady glow when reduce-flashes / reduce-motion is set. The runtime gives the placed +
    // sized box; the view only positions/scales/colours it (V1/V2 — never reads world state back).
    const highlight = runtime.nearestInteractableHighlight();
    highlightView.update(highlight, dt, access.feedback.reduceFlashes || access.feedback.reduceMotion);
    // T136: the world cursor follows the pointer ground point (hidden while a panel owns the mouse); GREEN when an
    // interactable is selected (highlight present) so the player sees "ready to interact" right at the cursor.
    cursorView.update(uiCaptures ? null : pointer, highlight !== null);

    // Item A: a loot panel opened on a world container is proximity-gated — auto-close it the moment the
    // player walks out of interaction range of THAT container (or turns to a different one). A manually-opened
    // (I) inventory has no lootAnchor, so it is never auto-closed here.
    {
      const inv = inventoryViewStore.getState();
      if (inv.lootAnchor && uiStore.getState().activePanel === 'inventory') {
        const near = runtime.nearestInteractableTarget();
        if (!near || near.kind !== 'container' || near.label !== inv.lootAnchor) {
          inv.setLootAnchor(null);
          uiStore.getState().closePanel();
        }
      }
    }
    // T126/V91: a render-side DEV override of the day/night phase (lighting only — the sim clock is untouched,
    // so replay stays exact). When enabled, lighting parks the sun at `override`; else it follows the sim clock.
    const tod = timeOfDayStore.getState();
    const todOverride = tod.overrideEnabled ? tod.override : null;
    scene.syncFrame(dt, camera.camera, debugViewStore.getState().flags, todOverride);
    // T127: advance the rigged player avatar's animation state machine (mixer + crossfades). Real `dt` so the
    // animation stays smooth; `moving`/`sprinting` are the gated intent signals above; crouch/death/hit are read
    // from the runtime inside (a fresh damage tick fires the one-shot hit reaction). No-op until the GLB attaches.
    scene.updatePlayerAvatar(dt, avatarMoving, avatarSprinting);
    // Publish the effective day fraction the lighting used (override or sim clock) for the HUD clock, minute-gated.
    const todMinute = Math.floor(scene.currentTimeOfDay * 1440) % 1440;
    if (todMinute !== lastTodMinute) {
      lastTodMinute = todMinute;
      timeOfDayStore.getState().setCurrent(scene.currentTimeOfDay);
    }
    gizmos.update(
      runtime.zombies,
      debugViewStore.getState().flags,
      { x: p.x, z: p.z, heading: runtime.playerAim() },
      (qx, qz) =>
        runtime.stimulus
          .query(qx, qz, runtime.tick)
          .filter((h) => h.stimulus.kind === 'sound')
          .map((h) => ({ x: h.stimulus.x, z: h.stimulus.z, intensity: h.intensity, radius: h.stimulus.radius })),
      // V83/V84: crop the vision polygons on the SEE-THROUGH scene (windows transparent, see-over obstacles
      // skipped) so the player + zombie debug rims penetrate windows/openings exactly like the gameplay vision.
      (qx, qz, heading, maxR) => rayDistanceToWall(runtime.sightScene, qx, qz, heading, maxR),
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
    // Player pain grunt on a fresh damage hit (one per hit — gated on the sim's last-damage tick advancing).
    const dmgTick = runtime.playerLastDamageTick();
    if (dmgTick > lastGruntDamageTick) {
      lastGruntDamageTick = dmgTick;
      gameAudio.grunt();
    }
    // Reload sample on the start of a reload (manual or automatic).
    const reloading = runtime.ammoStatus().reloading;
    if (reloading && !lastReloading) gameAudio.reload();
    lastReloading = reloading;
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
