// V1 / V11 — noise-view store. A UI-only DERIVED view (not a frozen sim contract): the engine PUSHES a
// coarse, throttled noise reading; the HUD reads narrow selectors out. Drives the at-a-glance noise meter
// (how loud it is AROUND the player + how much noise the PLAYER is producing). Never per-frame world state.

import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';
import { createThrottledPublisher, type Now } from './throttle';
import { resolve } from '../config/spec';
import { uiConfig } from '../config/domains/UI';
import type { QualityTier } from '../config/types';

/** Coarse 0..1 noise reading published to the HUD (throttled). */
export interface NoiseViewSnapshot {
  /** Loudness of the environment reaching the player's position (0 = silent, 1 = deafening). */
  readonly ambient01: number;
  /** How much noise the PLAYER is currently producing (recent gunfire/footsteps), decaying. */
  readonly self01: number;
}

export interface NoiseViewState {
  readonly snapshot: NoiseViewSnapshot | null;
  applySnapshot(snapshot: NoiseViewSnapshot): void;
  clear(): void;
}

export function createNoiseViewStore() {
  return createStore<NoiseViewState>()(
    subscribeWithSelector((set) => ({
      snapshot: null,
      applySnapshot: (snapshot) => set({ snapshot }),
      clear: () => set({ snapshot: null }),
    })),
  );
}

export const noiseViewStore = createNoiseViewStore();
export type NoiseViewStore = typeof noiseViewStore;

/** Engine-side throttled publisher for noise snapshots (reuses the player-snapshot cadence; V11). */
export function createNoiseSnapshotGate(store: NoiseViewStore, tier: QualityTier, now?: Now) {
  const intervalMs = resolve(uiConfig.playerSnapshotThrottleMs, tier);
  return createThrottledPublisher<NoiseViewSnapshot>((s) => store.getState().applySnapshot(s), intervalMs, now);
}
