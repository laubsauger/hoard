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

/**
 * M2 mission status for the objective HUD panel (T40). A plain, throttled structural snapshot — the
 * store (lane U) owns this shape so it never imports game-lane internals; the runtime maps its objective/
 * event/district state onto it. Counts + phases only, never per-frame world arrays (V1/V11).
 */
export interface MissionStatus {
  readonly objectivePhase: string;
  readonly directive: string;
  readonly partsFound: number;
  readonly partsRequired: number;
  readonly repairProgressTicks: number;
  readonly repairRequiredTicks: number;
  readonly evacuationTicksRemaining: number | null;
  readonly canAdvance: boolean;
  /** Decisive horde event. */
  readonly eventPhase: string;
  readonly eventBuildupProgress: number;
  readonly eventOutcome: string | null;
  readonly eventPressure: number | null;
  readonly openRoutes: number;
  readonly reinforcedRoutes: number;
  /** District streaming readout. */
  readonly activeSectors: number;
  readonly liveDistrictPop: number;
  readonly abstractDistrictPop: number;
}

export interface MapViewState {
  readonly horde: HordeViewSnapshot | null;
  readonly mission: MissionStatus | null;
  readonly markers: readonly MapMarker[];
  applyHorde(horde: HordeViewSnapshot): void;
  applyMission(mission: MissionStatus): void;
  setMarkers(markers: readonly MapMarker[]): void;
}

export function createMapViewStore() {
  return createStore<MapViewState>()(
    subscribeWithSelector((set) => ({
      horde: null,
      mission: null,
      markers: [],
      applyHorde: (horde) => set({ horde }),
      applyMission: (mission) => set({ mission }),
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

/** Engine-side throttled publisher for the M2 mission/objective status (V11). */
export function createMissionSnapshotGate(store: MapViewStore, tier: QualityTier, now?: Now) {
  const intervalMs = resolve(uiConfig.hordeSnapshotThrottleMs, tier);
  return createThrottledPublisher<MissionStatus>((s) => store.getState().applyMission(s), intervalMs, now);
}
