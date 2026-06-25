// Phase 3 (GameViewport decomposition): the slice-level engine handle the React shell drives.
// Commands flow UI → engine as validated intent (V1). Every method reads the LIVE runtime via
// getRuntime() because the runtime binding is reassigned on reload; the load path rebuilds a fresh
// district+runtime, publishes it back through setRuntime, rebinds the scene, and re-surfaces inventory.

import type { CameraRig } from '../../render/engine';
import type { BlockScene } from '../../render/scene';
import type { GameAudio } from '../../audio-out';
import type { GameRuntime } from '../../game/runtime';
import type { PersistenceAdapter } from '../../game/persistence';
import type { QualityTier } from '../../config/types';
import type { CommandId, EntityId, ModuleId } from '../../game/core/contracts';
import type { EquipSlot } from '../../game/inventory';
import type { InteractionPrompt, InteractionTargetWorld } from '../../game/interaction';
import type { WeatherProfile } from '../../config/domains/weather';
import { inputStore, formatKeyCode } from '../../stores/input';
import { inventoryViewStore } from '../../stores/inventoryView';
import { uiStore } from '../../stores/ui';
import { createGameRuntime } from './gameRuntime';
import { worldToScreen as projectWorldToScreen, type ScreenPoint } from './worldToScreen';

/** Layout tunables for the world-anchored interaction prompt (T113) — a STABLE frozen ref so reading it inside
 *  a React selector never returns a fresh object (B24/V11). Resolved once from `uiConfig` at handle creation. */
export interface PromptLayout {
  /** World height (m) above the interactable the prompt is anchored to. */
  readonly anchorHeightMeters: number;
  /** Screen-px the prompt is lifted above its projected anchor. */
  readonly offsetPx: number;
  /** Min px from the viewport edges when clamping the prompt on-screen. */
  readonly marginPx: number;
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
  /** T138: USE (consume) one unit of a consumable from the player inventory — eat/drink/treat. Re-publishes the
   *  inventory so the reduced count surfaces immediately; the HUD survival vitals update on the next snapshot. */
  useItem(item: number): void;
  /** T139: wear a carried backpack (raises carry capacity) / take it off (restored, refused while overloaded). */
  equipBackpack(): void;
  unequipBackpack(): void;
  /** T139: whether a backpack is currently worn (drives the inventory equip/remove toggle). */
  isBackpackEquipped(): boolean;
  /** T140: stow a carried item into an equipment slot (holster/back/belt L/belt R) — validated by weapon class. */
  equipItem(item: number, slot: EquipSlot): void;
  /** T140: take the item out of an equipment slot back into the pack (drops to unarmed if it was active). */
  unequipSlot(slot: EquipSlot): void;
  /** T140: draw an equipment slot to hands (make it the active weapon), or re-holster if already active. */
  drawSlot(slot: EquipSlot): void;
  /** T140: the equipment slots an item may be stowed in (drives the inventory attach picker). */
  equippableSlots(item: number): EquipSlot[];
  /** T85: drop an item from the pack onto the floor at the player's feet (a lootable pile, no container needed). */
  drop(item: number): void;
  /** T113: project a world point to viewport CSS px (page coords), or null when off-screen/behind the camera —
   *  reuses the live tactical camera so the world-anchored prompt floats next to the real object (V11). */
  worldToScreen(x: number, y: number, z: number): ScreenPoint | null;
  /** T113: stable layout tunables for the world-anchored interaction prompt (anchor height / offset / margin). */
  readonly promptLayout: PromptLayout;
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
  /** Audio output — door / container interaction sounds fire from the command results here (V1 boundary). */
  readonly gameAudio: GameAudio;
  /** The viewport canvas — its client rect maps NDC → CSS px for the world-anchored prompt (T113). */
  readonly canvas: HTMLCanvasElement;
  /** Resolved world-anchored prompt layout tunables (T113, from `uiConfig`). */
  readonly promptLayout: PromptLayout;
  /** Live runtime accessor (reassigned on reload). */
  readonly getRuntime: () => GameRuntime;
  /** Publish a freshly-loaded runtime back to the viewport binding (load path). */
  readonly setRuntime: (runtime: GameRuntime) => void;
  /** Re-surface the current runtime's inventory into the view store (T85). */
  readonly publishInventory: () => void;
}

export function createEngineHandle(args: CreateEngineHandleArgs): EngineHandle {
  const { tier, adapter, camera, scene, gameAudio, canvas, getRuntime, setRuntime, publishInventory } = args;
  const promptLayout: PromptLayout = Object.freeze({ ...args.promptLayout });
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
    toggleNearestDoor: () => {
      const access = getRuntime().toggleNearestDoor(); // 'open' | 'closed' | 'locked' | null
      if (access === 'open') gameAudio.doorOpen();
      else if (access === 'closed') gameAudio.doorClose();
    },
    // T108 window verbs. Board-up consumes planks + a tool; pry returns the planks — re-publish the
    // inventory so the HUD plank count updates immediately (V1). Climb VAULTS the player to the far side of
    // an opening (V70) — a player-only move; the window cell stays a blocked wall in nav (V68), never cleared.
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
      gameAudio.containerOpen(); // cardboard-box open sound on the loot action
      inventoryViewStore.getState().setOpenContainer(t.label);
      // Anchor the panel to THIS world container so the render loop auto-closes it when the player walks out
      // of interaction range (item A — the loot panel is proximity-gated, unlike a manual `I` inventory).
      inventoryViewStore.getState().setLootAnchor(t.label);
      uiStore.getState().openPanel('inventory');
    },
    useItem: (item) => {
      if (getRuntime().useItem(item)) {
        gameAudio.containerOpen(); // a soft confirmation tick on a successful use (reuses the cardboard sfx)
        publishInventory(); // re-surface the reduced count immediately (V1)
      }
    },
    equipBackpack: () => {
      if (getRuntime().equipBackpack()) {
        gameAudio.containerOpen();
        publishInventory(); // capacity rose → re-surface so the pane header reflects it
      }
    },
    unequipBackpack: () => {
      if (getRuntime().unequipBackpack()) {
        gameAudio.containerOpen();
        publishInventory();
      }
    },
    isBackpackEquipped: () => getRuntime().isBackpackEquipped(),
    // T140: equipment-slot intents. Each mutates the sim's containers + active-weapon pointer, then re-surfaces
    // the inventory so the paper-doll + hotbar + HUD reflect the new loadout immediately (mirrors equipBackpack).
    equipItem: (item, slot) => {
      if (getRuntime().equipItem(item, slot)) {
        gameAudio.containerOpen();
        publishInventory();
      }
    },
    unequipSlot: (slot) => {
      if (getRuntime().unequipSlot(slot)) {
        gameAudio.containerOpen();
        publishInventory();
      }
    },
    drawSlot: (slot) => {
      getRuntime().drawSlot(slot);
      publishInventory(); // active-slot highlight + active weapon changed
    },
    equippableSlots: (item) => getRuntime().equippableSlots(item),
    drop: (item) => {
      if (getRuntime().dropItem(item)) {
        gameAudio.containerOpen(); // a soft thud-ish confirmation (reuses the cardboard sfx)
        publishInventory();
      }
    },
    worldToScreen: (x, y, z) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const p = projectWorldToScreen(camera.camera, x, y, z, rect.width, rect.height);
      if (p.behind) return null; // behind the camera — the projection mirrors; don't draw
      return { x: rect.left + p.x, y: rect.top + p.y, behind: false };
    },
    promptLayout,
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
