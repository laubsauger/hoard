// Phase 3 (GameViewport decomposition): player input wiring for the viewport.
// Registers the 5 DOM listeners — window keydown/keyup, canvas mousemove/click/wheel — and routes them
// through the runtime as validated intent (V1). Movement keys are sampled by the frame loop (it reads
// the shared `keys` Set); this module only tracks key state, aim, camera rotate/zoom, and the fire path
// (gunshot audio → runtime.fire → tracer feedback → the distinct structure/body impact branch, V57).
// Every listener is balanced by the returned cleanup. `runtime` and `access` are read through live
// accessors because the runtime is reassigned on reload and accessibility is live-applied.

import { type CameraRig } from '../../render/engine';
import type { BlockScene } from '../../render/scene';
import type { GameRuntime } from '../../game/runtime';
import type { GameAudio } from '../../audio-out';
import type { RenderAccessibility } from '../../render/accessibility';
import { ImpactView, type ImpactIngestContext } from '../../render/effects/impactView';
import type { RaycastSurfaceProjector } from '../../render/effects/surfaceProjector';
import { inputStore } from '../../stores/input';
import { sessionStore } from '../../stores/session';
import { debugViewStore } from '../../diagnostics/store';
import { AimRaycaster } from './aim';

export interface RegisterInputArgs {
  readonly canvas: HTMLCanvasElement;
  readonly camera: CameraRig;
  readonly aim: AimRaycaster;
  /** Shared held-key set (the loop samples it for movement/sprint/sneak). */
  readonly keys: Set<string>;
  readonly gameAudio: GameAudio;
  readonly scene: BlockScene;
  readonly impactView: ImpactView;
  readonly surfaceProjector: RaycastSurfaceProjector;
  readonly firearmRangeMeters: number;
  /** Live runtime accessor (reassigned on reload). */
  readonly getRuntime: () => GameRuntime;
  /** Live accessibility accessor (live-applied from settings). */
  readonly getAccess: () => RenderAccessibility;
  /** Bump the player-produced noise to max (a gunshot is the loudest thing the player makes). */
  readonly bumpSelfNoise: () => void;
}

/** Wire the viewport input listeners; returns a single cleanup that removes all of them. */
export function registerInput(args: RegisterInputArgs): () => void {
  const { canvas, camera, aim, keys, gameAudio, scene, impactView, surfaceProjector, firearmRangeMeters, getRuntime, getAccess, bumpSelfNoise } = args;

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
    if (e.code === 'KeyR') getRuntime().reloadWeapon();
    if (e.code === 'BracketRight') getRuntime().cycleWeapon(1);
    if (e.code === 'BracketLeft') getRuntime().cycleWeapon(-1);
    // T98: L toggles the player flashlight (the dev-tools panel exposes the same flag). NOT F — F is the
    // interact key (InteractionWheel); double-binding F toggled the light every time you interacted.
    if (e.code === 'KeyL') debugViewStore.getState().toggleFlag('flashlight');
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    keys.delete(e.code);
  };
  const onMouseMove = (e: MouseEvent): void => {
    aim.setFromPointer(e.clientX, e.clientY, canvas.getBoundingClientRect());
  };
  const onClick = (): void => {
    gameAudio.resume(); // autoplay policy: a click is a valid gesture to start audio.
    gameAudio.gunshot(); // procedural gunshot synthesized directly off the player-fire path.
    const runtime = getRuntime();
    const access = getAccess();
    const hit = aim.worldPoint(camera);
    const p = runtime.player();
    const dx = hit ? hit.x - p.x : Math.cos(runtime.playerAim());
    const dz = hit ? hit.z - p.z : Math.sin(runtime.playerAim());
    runtime.aim(dx, dz);
    const shot = runtime.fire(dx, dz, 'torsoUpper');
    bumpSelfNoise(); // a gunshot is the loudest thing the player produces (HUD noise meter).
    // Pass the authoritative stop distance (struck body or first wall) so the tracer terminates there and
    // never draws through a wall on a miss into structure (V49/V53/B20).
    scene.fireFeedback(dx, dz, shot.stopDistanceMeters); // B7: muzzle flash + tracer + report on fire
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
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('click', onClick);
    canvas.removeEventListener('wheel', onWheel);
  };
}
