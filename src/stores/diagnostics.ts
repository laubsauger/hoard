// T4 / V11 / V27 — diagnostics store. NOT persisted. The engine pushes counters (throttled); debug
// overlays (T35, lane X) read them via selectors. Never holds per-frame world arrays (V1).

import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';
import { createThrottledPublisher, type Now } from './throttle';
import { resolve } from '../config/spec';
import { uiConfig } from '../config/domains/UI';
import type { QualityTier } from '../config/types';

export interface DiagnosticsCounters {
  readonly fps: number;
  readonly frameMs: number;
  readonly mainThreadMs: number;
  readonly gpuMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly instances: number;
  readonly liveCrowdInstances: number;
  readonly ticks: number;
  readonly trackedResources: number;
}

export const ZERO_COUNTERS: DiagnosticsCounters = {
  fps: 0,
  frameMs: 0,
  mainThreadMs: 0,
  gpuMs: 0,
  drawCalls: 0,
  triangles: 0,
  instances: 0,
  liveCrowdInstances: 0,
  ticks: 0,
  trackedResources: 0,
};

export interface DiagnosticsState {
  readonly counters: DiagnosticsCounters;
  readonly tier: QualityTier | null;
  readonly overlayVisible: boolean;
  applyCounters(counters: DiagnosticsCounters): void;
  setTier(tier: QualityTier | null): void;
  setOverlayVisible(visible: boolean): void;
}

export function createDiagnosticsStore() {
  return createStore<DiagnosticsState>()(
    subscribeWithSelector((set) => ({
      counters: ZERO_COUNTERS,
      tier: null,
      overlayVisible: false,
      applyCounters: (counters) => set({ counters }),
      setTier: (tier) => set({ tier }),
      setOverlayVisible: (overlayVisible) => set({ overlayVisible }),
    })),
  );
}

export const diagnosticsStore = createDiagnosticsStore();
export type DiagnosticsStore = typeof diagnosticsStore;

/** Engine-side throttled publisher for diagnostics counters (V11). */
export function createDiagnosticsGate(store: DiagnosticsStore, tier: QualityTier, now?: Now) {
  const intervalMs = resolve(uiConfig.diagnosticsSnapshotThrottleMs, tier);
  return createThrottledPublisher<DiagnosticsCounters>((c) => store.getState().applyCounters(c), intervalMs, now);
}
