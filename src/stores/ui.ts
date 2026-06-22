// T4 / V1 / V11 — UI + modal store. NOT persisted. Owns shell/panel/modal/loading/error state only,
// never per-frame world state (V1).

import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';

export type PanelId = 'none' | 'inventory' | 'crafting' | 'map' | 'pause' | 'settings';

export interface UiState {
  readonly activePanel: PanelId;
  readonly modalStack: readonly string[];
  readonly hudVisible: boolean;
  readonly loadingProgress: number; // 0..1
  readonly errorMessage: string | null;
  openPanel(panel: PanelId): void;
  closePanel(): void;
  pushModal(id: string): void;
  popModal(): void;
  setHudVisible(visible: boolean): void;
  setLoadingProgress(progress: number): void;
  setError(message: string | null): void;
}

export function createUiStore() {
  return createStore<UiState>()(
    subscribeWithSelector((set) => ({
      activePanel: 'none',
      modalStack: [],
      hudVisible: true,
      loadingProgress: 0,
      errorMessage: null,
      openPanel: (activePanel) => set({ activePanel }),
      closePanel: () => set({ activePanel: 'none' }),
      pushModal: (id) => set((s) => ({ modalStack: [...s.modalStack, id] })),
      popModal: () => set((s) => ({ modalStack: s.modalStack.slice(0, -1) })),
      setHudVisible: (hudVisible) => set({ hudVisible }),
      setLoadingProgress: (progress) => {
        if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
          throw new Error(`loadingProgress must be in [0,1], got ${progress}`);
        }
        set({ loadingProgress: progress });
      },
      setError: (errorMessage) => set({ errorMessage }),
    })),
  );
}

export const uiStore = createUiStore();
export type UiStore = typeof uiStore;
