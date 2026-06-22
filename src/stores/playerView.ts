// T4 / V1 / V11 — player-view store. NOT persisted. The engine PUSHES PlayerViewSnapshot in (throttled);
// React reads narrow primitive selectors out. React never owns or mutates per-frame world state (V1).

import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';
import type { PlayerViewSnapshot } from '../game/core/contracts';
import { createThrottledPublisher, type Now } from './throttle';
import { resolve } from '../config/spec';
import { uiConfig } from '../config/domains/UI';
import type { QualityTier } from '../config/types';

export interface PlayerViewState {
  readonly snapshot: PlayerViewSnapshot | null;
  /** Apply a published snapshot. Engine calls this (typically through the throttled gate). */
  applySnapshot(snapshot: PlayerViewSnapshot): void;
  clear(): void;
}

export function createPlayerViewStore() {
  return createStore<PlayerViewState>()(
    subscribeWithSelector((set) => ({
      snapshot: null,
      applySnapshot: (snapshot) => set({ snapshot }),
      clear: () => set({ snapshot: null }),
    })),
  );
}

export const playerViewStore = createPlayerViewStore();
export type PlayerViewStore = typeof playerViewStore;

/**
 * Build the engine-side throttled publisher for player snapshots (V11 health-interp throttle).
 * Interval comes from the UI config domain resolved for the active tier — no magic number.
 */
export function createPlayerSnapshotGate(
  store: PlayerViewStore,
  tier: QualityTier,
  now?: Now,
) {
  const intervalMs = resolve(uiConfig.playerSnapshotThrottleMs, tier);
  return createThrottledPublisher<PlayerViewSnapshot>(
    (s) => store.getState().applySnapshot(s),
    intervalMs,
    now,
  );
}
