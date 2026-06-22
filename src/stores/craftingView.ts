// T4 / V1 / V11 — crafting-view store. NOT persisted. Engine publishes contextual valid actions/recipes;
// React reads them via selectors and issues `craft` commands back through the command contract.

import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';

export interface CraftActionView {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly reason: string | null; // why unavailable, if not
}

export interface CraftingViewState {
  readonly actions: readonly CraftActionView[];
  readonly contextTarget: number | null; // ModuleId/EntityId numeric, contextual target
  setActions(actions: readonly CraftActionView[]): void;
  setContextTarget(target: number | null): void;
}

export function createCraftingViewStore() {
  return createStore<CraftingViewState>()(
    subscribeWithSelector((set) => ({
      actions: [],
      contextTarget: null,
      setActions: (actions) => set({ actions }),
      setContextTarget: (contextTarget) => set({ contextTarget }),
    })),
  );
}

export const craftingViewStore = createCraftingViewStore();
export type CraftingViewStore = typeof craftingViewStore;
