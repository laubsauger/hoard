// T4 / V1 / V11 — inventory-view store. NOT persisted. Holds a view-model projection the engine publishes;
// authoritative containers live in the sim (lane S). React reads slots via selectors only.

import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';

export interface InventorySlotView {
  readonly item: number; // ItemId numeric value (contract id)
  readonly count: number;
}

export interface ContainerView {
  readonly container: string;
  readonly capacity: number;
  readonly weight: number;
  readonly slots: readonly InventorySlotView[];
}

export interface InventoryViewState {
  readonly containers: readonly ContainerView[];
  readonly openContainer: string | null;
  /**
   * The label of the WORLD container the loot panel is anchored to (set when the panel was opened by the F
   * "search" verb on a container). Proximity-gated: the render loop auto-closes the panel when the player walks
   * out of interaction range of THIS container. `null` for a manually-opened (I) inventory, which has no
   * proximity gate and stays open until I/Esc.
   */
  readonly lootAnchor: string | null;
  setContainers(containers: readonly ContainerView[]): void;
  setOpenContainer(container: string | null): void;
  setLootAnchor(container: string | null): void;
  /** Move a whole item stack between two containers in the view (demo transfer until the sim owns it). */
  transfer(fromContainer: string, toContainer: string, item: number): void;
}

/** Move the whole `item` stack from `from` to `to`, merging counts + recomputing weight. Pure view update. */
function applyTransfer(
  containers: readonly ContainerView[],
  from: string,
  to: string,
  item: number,
): readonly ContainerView[] {
  const src = containers.find((c) => c.container === from);
  const moved = src?.slots.find((s) => s.item === item);
  if (!src || !moved) return containers;
  return containers.map((c) => {
    if (c.container === from) {
      const slots = c.slots.filter((s) => s.item !== item);
      return { ...c, slots, weight: slots.reduce((w, s) => w + s.count, 0) };
    }
    if (c.container === to) {
      const existing = c.slots.find((s) => s.item === item);
      const slots = existing
        ? c.slots.map((s) => (s.item === item ? { ...s, count: s.count + moved.count } : s))
        : [...c.slots, { item, count: moved.count }];
      return { ...c, slots, weight: slots.reduce((w, s) => w + s.count, 0) };
    }
    return c;
  });
}

export function createInventoryViewStore() {
  return createStore<InventoryViewState>()(
    subscribeWithSelector((set) => ({
      containers: [],
      openContainer: null,
      lootAnchor: null,
      setContainers: (containers) => set({ containers }),
      setOpenContainer: (openContainer) => set({ openContainer }),
      setLootAnchor: (lootAnchor) => set({ lootAnchor }),
      transfer: (from, to, item) => set((s) => ({ containers: applyTransfer(s.containers, from, to, item) })),
    })),
  );
}

export const inventoryViewStore = createInventoryViewStore();
export type InventoryViewStore = typeof inventoryViewStore;
