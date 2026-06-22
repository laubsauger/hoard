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
  setContainers(containers: readonly ContainerView[]): void;
  setOpenContainer(container: string | null): void;
}

export function createInventoryViewStore() {
  return createStore<InventoryViewState>()(
    subscribeWithSelector((set) => ({
      containers: [],
      openContainer: null,
      setContainers: (containers) => set({ containers }),
      setOpenContainer: (openContainer) => set({ openContainer }),
    })),
  );
}

export const inventoryViewStore = createInventoryViewStore();
export type InventoryViewStore = typeof inventoryViewStore;
