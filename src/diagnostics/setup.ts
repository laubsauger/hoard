// T35 / V4 — wiring: resolve the debug config for the active tier and assemble the diagnostics
// runtime (collector + flag state + overlay store + throttled publisher). Config resolution happens
// only here at the boundary; collectors/flags themselves take plain values so they stay testable
// without the config registry.

import { resolveDomain } from '../config/registry';
import type { QualityTier } from '../config/types';
import { debugConfig } from '../config/domains/debug';
import { DiagnosticsCollector, type DiagnosticsSnapshot } from './collector';
import { DebugFlagState } from './flags';
import { createDebugViewStore, type DebugViewStore } from './store';
import { createSnapshotPublisher, type Now } from './throttle';

export interface DiagnosticsRuntime {
  readonly collector: DiagnosticsCollector;
  readonly flags: DebugFlagState;
  readonly store: DebugViewStore;
  /** Snapshot the collector and publish to the store (throttled to debug.refreshThrottleMs). */
  publish(): void;
  /** Force-deliver any coalesced snapshot (e.g. on pause/teardown). */
  flush(): void;
  /** Push the current flag state into the store so the overlay re-renders. */
  syncFlags(): void;
}

/** Build the diagnostics runtime for a quality tier. Overlay visibility follows the per-build default. */
export function createDiagnostics(tier: QualityTier, now?: Now): DiagnosticsRuntime {
  const cfg = resolveDomain(debugConfig, tier);
  const collector = new DiagnosticsCollector(cfg.percentileWindowSize, cfg.markerHistorySize);
  const flags = new DebugFlagState();
  const store = createDebugViewStore(cfg.overlayEnabledByDefault);

  const publisher = createSnapshotPublisher<DiagnosticsSnapshot>(
    (s) => store.getState().applySnapshot(s),
    cfg.refreshThrottleMs,
    now,
  );

  return {
    collector,
    flags,
    store,
    publish: () => publisher.push(collector.snapshot()),
    flush: () => publisher.flushPending(),
    syncFlags: () => store.getState().applyFlags(flags.get()),
  };
}
