// T4 / V1 / V11 — map-view store. NOT persisted. Holds coarse horde pressure (counts, not entities) +
// discovered markers. The engine publishes HordeViewSnapshot (throttled); React reads via selectors.

import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';
import type { HordeViewSnapshot } from '../game/core/contracts';
import { createThrottledPublisher, type Now } from './throttle';
import { resolve } from '../config/spec';
import { uiConfig } from '../config/domains/UI';
import type { QualityTier } from '../config/types';

export interface MapMarker {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly kind: 'objective' | 'shelter' | 'threat' | 'note';
}

export interface MapViewState {
  readonly horde: HordeViewSnapshot | null;
  readonly markers: readonly MapMarker[];
  applyHorde(horde: HordeViewSnapshot): void;
  setMarkers(markers: readonly MapMarker[]): void;
}

export function createMapViewStore() {
  return createStore<MapViewState>()(
    subscribeWithSelector((set) => ({
      horde: null,
      markers: [],
      applyHorde: (horde) => set({ horde }),
      setMarkers: (markers) => set({ markers }),
    })),
  );
}

export const mapViewStore = createMapViewStore();
export type MapViewStore = typeof mapViewStore;

/** Engine-side throttled publisher for horde pressure snapshots (V11). */
export function createHordeSnapshotGate(store: MapViewStore, tier: QualityTier, now?: Now) {
  const intervalMs = resolve(uiConfig.hordeSnapshotThrottleMs, tier);
  return createThrottledPublisher<HordeViewSnapshot>((s) => store.getState().applyHorde(s), intervalMs, now);
}
