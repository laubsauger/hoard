// Phase 3 (GameViewport decomposition): the slice-level engine handle the React shell drives.
// Commands flow UI → engine as validated intent (V1). Every method reads the LIVE runtime via
// getRuntime() because the runtime binding is reassigned on reload; the load path rebuilds a fresh
// district+runtime, publishes it back through setRuntime, rebinds the scene, and re-surfaces inventory.

import type { CameraRig } from '../../render/engine';
import type { BlockScene } from '../../render/scene';
import type { GameRuntime } from '../../game/runtime';
import type { PersistenceAdapter } from '../../game/persistence';
import type { QualityTier } from '../../config/types';
import type { CommandId, EntityId, ModuleId } from '../../game/core/contracts';
import type { InteractionPrompt, InteractionTargetWorld } from '../../game/interaction';
import type { WeatherProfile } from '../../config/domains/weather';
import { inputStore, formatKeyCode } from '../../stores/input';
import { inventoryViewStore } from '../../stores/inventoryView';
import { uiStore } from '../../stores/ui';
import { createGameRuntime } from './gameRuntime';

/** The engine handle the React shell uses to issue slice-level intent (save/load/modify/weather). */
export interface EngineHandle {
  save(): Promise<void>;
  load(): Promise<void>;
  breach(): void;
  board(): void;
  ignite(): void;
  /** T46/T60: toggle the door NEAREST the player (open↔closed). No-op when none is in reach. */
  toggleNearestDoor(): void;
  /** T108: window verbs for the NEAREST window in reach (smash glass / board up / pry boards off / climb). */
  smashWindow(): void;
  boardWindow(): void;
  removeWindowBoard(): void;
  climbWindow(): void;
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

export interface CreateEngineHandleArgs {
  readonly tier: QualityTier;
  readonly adapter: PersistenceAdapter;
  readonly camera: CameraRig;
  readonly scene: BlockScene;
  /** Live runtime accessor (reassigned on reload). */
  readonly getRuntime: () => GameRuntime;
  /** Publish a freshly-loaded runtime back to the viewport binding (load path). */
  readonly setRuntime: (runtime: GameRuntime) => void;
  /** Re-surface the current runtime's inventory into the view store (T85). */
  readonly publishInventory: () => void;
}

export function createEngineHandle(args: CreateEngineHandleArgs): EngineHandle {
  const { tier, adapter, camera, scene, getRuntime, setRuntime, publishInventory } = args;
  let cmdSeq = 1;
  const nextCmd = (): CommandId => cmdSeq++ as unknown as CommandId;
  return {
    save: () => getRuntime().save(),
    load: async () => {
      const fresh = createGameRuntime(tier, adapter);
      await fresh.loadFrom();
      setRuntime(fresh);
      scene.rebindRuntime(fresh);
      publishInventory(); // re-surface the reloaded runtime's inventory (T85)
    },
    breach: () => {
      const runtime = getRuntime();
      runtime.dispatch({ kind: 'modifyStructure', id: nextCmd(), module: runtime.scene.moduleId as ModuleId, cell: runtime.defaultBreachCell(), op: 'breach' });
    },
    board: () => {
      const runtime = getRuntime();
      runtime.dispatch({ kind: 'modifyStructure', id: nextCmd(), module: runtime.scene.moduleId as ModuleId, cell: runtime.defaultBreachCell(), op: 'board' });
    },
    ignite: () => getRuntime().igniteRoute(getRuntime().defaultBreachCell()),
    toggleNearestDoor: () => { getRuntime().toggleNearestDoor(); },
    // T108 window verbs. Board-up consumes planks + a tool; pry returns the planks — re-publish the
    // inventory so the HUD plank count updates immediately (V1). Climb is flavour (the opening is already
    // passable — its nav cell is cleared), so it is a no-op that simply closes the wheel.
    smashWindow: () => { getRuntime().smashNearestWindow(); },
    boardWindow: () => { if (getRuntime().boardNearestWindow()) publishInventory(); },
    removeWindowBoard: () => { if (getRuntime().unboardNearestWindow()) publishInventory(); },
    climbWindow: () => { getRuntime().climbThroughNearestWindow(); },
    nearestInteraction: () => getRuntime().nearestInteractionPrompt(formatKeyCode(inputStore.getState().bindings.interact)),
    nearestInteractable: () => getRuntime().nearestInteractableTarget(),
    loot: () => {
      // Open the dual-pane inventory ON the looted container (was only setting the container, never the
      // panel, so nothing showed — the InventoryMenu is gated on uiStore.activePanel === 'inventory').
      // No fallback: if no container is in reach there is nothing to loot — do nothing.
      const t = getRuntime().nearestInteractableTarget();
      if (t?.kind !== 'container') return;
      inventoryViewStore.getState().setOpenContainer(t.label);
      uiStore.getState().openPanel('inventory');
    },
    rotate: (dir) => camera.rotate(dir),
    zoom: (delta) => camera.setZoom(camera.state.zoom + delta),
    setWeather: (profile) => getRuntime().setWeather(profile),
    collectPart: () => {
      const runtime = getRuntime();
      runtime.dispatch({ kind: 'confirmAction', id: nextCmd(), entity: runtime.playerEntity as EntityId, action: 'objective.collectPart' });
    },
    repairRadio: () => {
      const runtime = getRuntime();
      runtime.dispatch({ kind: 'confirmAction', id: nextCmd(), entity: runtime.playerEntity as EntityId, action: 'objective.repair' });
    },
    advanceObjective: () => {
      const runtime = getRuntime();
      runtime.dispatch({ kind: 'confirmAction', id: nextCmd(), entity: runtime.playerEntity as EntityId, action: 'objective.advance' });
    },
  };
}
