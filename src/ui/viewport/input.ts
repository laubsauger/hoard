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
import { inventoryViewStore } from '../../stores/inventoryView';
import { interactionSelectStore } from '../../stores/interactionSelect';
import { sessionStore } from '../../stores/session';
import { uiStore } from '../../stores/ui';
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
  /** T140: re-publish the inventory view after an equip/draw/swap so the hotbar + paper-doll highlight update. */
  readonly publishInventory: () => void;
}

/** Wire the viewport input listeners; returns a single cleanup that removes all of them. */
export function registerInput(args: RegisterInputArgs): () => void {
  const { canvas, camera, aim, keys, gameAudio, scene, impactView, surfaceProjector, firearmRangeMeters, getRuntime, getAccess, bumpSelfNoise, publishInventory } = args;

  // T140: number keys 1..4 draw an equipment slot to hands (holster / back / belt L / belt R), in hotbar order.
  const HOTBAR_KEYS: Record<string, 'holster' | 'back' | 'beltL' | 'beltR'> = {
    Digit1: 'holster',
    Digit2: 'back',
    Digit3: 'beltL',
    Digit4: 'beltR',
  };

  // ---- input: WASD move, mouse aim, click fire, Q/E rotate, +/- zoom, B breach, R board ----
  const onKeyDown = (e: KeyboardEvent): void => {
    gameAudio.resume(); // autoplay policy: lazily create/resume the AudioContext on a user gesture.
    keys.add(e.code);
    // T50/V29: read the rebindable keymap so remapped rotate/pause keys take effect live.
    const b = inputStore.getState().bindings;
    if (e.code === b.rotateCCW) camera.rotate(-1);
    if (e.code === b.rotateCW) camera.rotate(1);
    if (e.code === b.pause) {
      // Escape PRIORITY: an open panel (inventory/settings/loot/…) closes FIRST — Escape only toggles pause
      // when nothing is open. (Before, Escape toggled pause even with the inventory up, so it "opened settings"
      // instead of closing the pane.) T49: pause HALTS the sim in the loop (V12-safe); phase stays 'playing'.
      if (uiStore.getState().activePanel !== 'none') {
        uiStore.getState().closePanel();
      } else if (sessionStore.getState().phase === 'playing') {
        sessionStore.getState().togglePause();
      }
    }
    // T74: reload (R) + cycle weapon ([ / ]). Direct keys for the prototype (rebindable bindings later).
    if (e.code === 'KeyR') getRuntime().reloadWeapon(); // reload sample plays from the render loop's reload-start edge (manual + auto)
    // T140: weapon swap ([ / ]) + hotbar draw (1..4) both change the ACTIVE equipment slot → re-publish the
    // inventory so the hotbar + paper-doll in-hands highlight tracks the new active weapon (V11).
    if (e.code === 'BracketRight') { getRuntime().cycleWeapon(1); publishInventory(); }
    if (e.code === 'BracketLeft') { getRuntime().cycleWeapon(-1); publishInventory(); }
    if (e.code in HOTBAR_KEYS && !e.repeat) { getRuntime().drawSlot(HOTBAR_KEYS[e.code]!); publishInventory(); }
    // T142: V throws a hand grenade toward the MOUSE aim point (clamped to throw range), if one is carried.
    if (e.code === 'KeyV' && !e.repeat) {
      const rt = getRuntime();
      const hp = aim.worldPoint(camera);
      const pp = rt.player();
      const gdx = hp ? hp.x - pp.x : Math.cos(rt.playerAim());
      const gdz = hp ? hp.z - pp.z : Math.sin(rt.playerAim());
      if (rt.throwGrenade(gdx, gdz)) publishInventory();
    }
    // T98: L toggles the player flashlight (the dev-tools panel exposes the same flag). NOT F — F is the
    // interact key (InteractionWheel); double-binding F toggled the light every time you interacted.
    if (e.code === 'KeyL') debugViewStore.getState().toggleFlag('flashlight');
    // T127: the rebindable emote key (default G) fires a one-shot push-up on the player avatar. Ignore the
    // OS key auto-repeat so holding it never re-triggers the emote every frame.
    if (e.code === b.emote && !e.repeat) scene.triggerPlayerEmote();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    keys.delete(e.code);
  };
  const onMouseMove = (e: MouseEvent): void => {
    aim.setFromPointer(e.clientX, e.clientY, canvas.getBoundingClientRect());
  };
  // Resolve ONE shot + its feedback (audio / muzzle / tracer / impact). Called on press, and again every frame
  // while the mouse is held for an AUTOMATIC weapon (the SMG) — the combat fire-rate gate enforces the real
  // cadence, so a too-soon call simply resolves no round (firedRounds 0) and this returns before any feedback.
  const fireOnce = (): void => {
    const runtime = getRuntime();
    const access = getAccess();
    const hit = aim.worldPoint(camera);
    const p = runtime.player();
    const dx = hit ? hit.x - p.x : Math.cos(runtime.playerAim());
    const dz = hit ? hit.z - p.z : Math.sin(runtime.playerAim());
    runtime.aim(dx, dz);
    // Aim center-mass; the sim SCATTERS the struck region per body (rollHitLocation) so limbs/head get hit
    // → dismemberment. The returned shot.region is the actual region struck (drives the wound mark below).
    const shot = runtime.fire(dx, dz, 'torsoUpper', { rollHitLocation: true });
    // A DRY CLICK (empty mag, nothing in reserve) fires no round — `firedRounds` is 0. Don't play the gunshot,
    // muzzle flash, tracer, recoil report, or self-noise for it (matches the runtime's own gunfire-noise gate);
    // otherwise the player "shoots" with no ammo. `undefined` = a melee/non-counting weapon, which DOES act.
    const didFire = shot.firedRounds === undefined || shot.firedRounds > 0;
    if (!didFire) return;
    const weaponId = runtime.currentWeaponId();
    const isMelee = weaponId === 'melee';
    if (isMelee) {
      // A swing — the item-swing whoosh, NOT a gunshot. No muzzle flash / tracer / max self-noise (a swing is
      // far quieter than a shot); the struck-body wound below still applies. (Fixes melee mis-playing the pistol.)
      gameAudio.swing();
    } else {
      gameAudio.gunshot(scene.isPlayerInsideBuilding(), weaponId); // per-weapon sample (shotgun fire+eject), indoor/outdoor pistol.
      bumpSelfNoise(); // a gunshot is the loudest thing the player produces (HUD noise meter).
      // Pass the authoritative stop distance (struck body or first wall) so the tracer terminates there and
      // never draws through a wall on a miss into structure (V49/V53/B20). B7 / T139: muzzle flash + a tracer FAN
      // (one trail per pellet across the equipped weapon's spread) + report on fire.
      const scatter = runtime.currentWeaponScatter();
      scene.fireFeedback(dx, dz, shot.stopDistanceMeters, scatter.pellets, scatter.spreadDegrees);
    }
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
      // Mark the wound ON the struck body (T81 surface-stick): anchored to the entity so it follows the moving
      // body + its corpse instead of floating where the shot landed; region->height + the shooter-facing normal
      // (-aim) place it on the surface. Falls through to nothing if the body already vanished (no anchor).
      if (shot.targetEntity != null) {
        impactView.woundOnBody(shot.targetEntity as unknown as number, shot.region ?? 'torsoUpper', -ndx, -ndz, impactCtx);
      }
    } else if (!isMelee && stop < firearmRangeMeters) {
      // Structure stop: spark + hole on the wall the round ACTUALLY stopped at. (Melee never punches wall holes.) The sim's `stop` already passed
      // any OPEN/smashed window (the round flies through the gap), so probe for the surface starting JUST BEFORE
      // the stop point rather than from the muzzle — otherwise the render ray returns the first solid wall mesh,
      // which behind a smashed window is the empty gap → a bullet hole stamped in mid-air where the pane used to
      // be. Starting the short probe past any opening lands the hole on the real blocker (a far wall, or a
      // boarded/closed window that genuinely stops the round). (Fixes the "holes in the open window" report.)
      const PROBE_BACK_METERS = 0.6; // begin a little behind the stop so the forward ray lands on the blocker face
      const PROBE_SPAN_METERS = 1.6; // covers small sim-grid ↔ render-mesh discrepancy without catching a wall beyond
      const sx = p.x + ndx * Math.max(0, stop - PROBE_BACK_METERS);
      const sz = p.z + ndz * Math.max(0, stop - PROBE_BACK_METERS);
      const wh = surfaceProjector.wallAlong(sx, p.y, sz, ndx, ndz, PROBE_SPAN_METERS);
      if (wh) impactView.structureImpact(wh.x, wh.y, wh.z, wh.nx, wh.ny, wh.nz, impactCtx);
    }
  };

  // Auto-fire: holding the mouse on an AUTOMATIC weapon (the SMG) keeps firing via a rAF loop until release; the
  // combat fire-rate gate paces the shots. A semi weapon fires once per press (no loop). The loop also stops if a
  // UI panel grabs the mouse mid-burst.
  let mouseHeld = false;
  let autoRaf = 0;
  const autoTick = (): void => {
    autoRaf = 0;
    if (!mouseHeld || uiStore.getState().activePanel !== 'none') return;
    fireOnce();
    autoRaf = requestAnimationFrame(autoTick);
  };
  const onPointerDown = (): void => {
    gameAudio.resume(); // autoplay policy: a press is a valid gesture to start audio (even a dry click).
    // A UI panel owns the mouse — a press reaching the CANVAS landed on the background. The inventory side-panel
    // (no backdrop) CLOSES on that background press + re-arms the player; other panels just swallow it.
    const panel = uiStore.getState().activePanel;
    if (panel !== 'none') {
      if (panel === 'inventory') {
        inventoryViewStore.getState().setOpenContainer(null);
        inventoryViewStore.getState().setLootAnchor(null);
        uiStore.getState().closePanel();
      }
      return;
    }
    // T142: if a THROWABLE (grenade) is the active equipped item, left-click THROWS it at the CURSOR (one per
    // click — not auto, not a gun shot) instead of firing.
    const rt = getRuntime();
    if (rt.equippedThrowable() !== null) {
      const hp = aim.worldPoint(camera);
      const pp = rt.player();
      const gdx = hp ? hp.x - pp.x : Math.cos(rt.playerAim());
      const gdz = hp ? hp.z - pp.z : Math.sin(rt.playerAim());
      if (rt.throwGrenade(gdx, gdz)) publishInventory();
      return;
    }
    mouseHeld = true;
    fireOnce();
    if (autoRaf === 0 && getRuntime().currentWeaponAutomatic()) autoRaf = requestAnimationFrame(autoTick);
  };
  const onMouseUp = (): void => {
    mouseHeld = false;
    if (autoRaf) {
      cancelAnimationFrame(autoRaf);
      autoRaf = 0;
    }
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // Plain wheel ZOOMS (the default — hijacking it for selection broke zoom in the common case). SHIFT+wheel
    // cycles the interaction option when verbs are in reach. Tap-F still uses the selected/headline verb.
    const sel = interactionSelectStore.getState();
    if (e.shiftKey && sel.verbCount > 0) {
      sel.cycle(e.deltaY >= 0 ? 1 : -1);
      return;
    }
    camera.setZoom(camera.state.zoom + Math.sign(e.deltaY) * 2);
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mouseup', onMouseUp); // window (not canvas) so releasing off-canvas still stops auto-fire
  canvas.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('mousedown', onPointerDown);
    window.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('wheel', onWheel);
    if (autoRaf) cancelAnimationFrame(autoRaf);
  };
}
