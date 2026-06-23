// T35 / V1 / V11 — overlay-facing store for the diagnostics snapshot + debug flags + visibility.
// Lane X owns this store (it lives under diagnostics/, not stores/). It holds ONLY plain aggregate
// snapshots and toggle state — never per-frame world arrays (V1). The overlay subscribes via narrow
// selectors (V11). Snapshot publishing is throttled to the debug.refreshThrottleMs cadence.

import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';
import { EMPTY_SNAPSHOT, type DiagnosticsSnapshot } from './collector';
import { DEFAULT_DEBUG_FLAGS, type BooleanDebugFlag, type DebugFlags } from './flags';

export interface DebugViewState {
  readonly snapshot: DiagnosticsSnapshot;
  readonly flags: DebugFlags;
  readonly overlayVisible: boolean;
  applySnapshot(snapshot: DiagnosticsSnapshot): void;
  applyFlags(flags: DebugFlags): void;
  /** Flip one boolean debug flag (used by the dev-tools toggle panel). */
  toggleFlag(key: BooleanDebugFlag): void;
  setOverlayVisible(visible: boolean): void;
  toggleOverlay(): void;
}

export function createDebugViewStore(overlayVisible = false) {
  return createStore<DebugViewState>()(
    subscribeWithSelector((set) => ({
      snapshot: EMPTY_SNAPSHOT,
      flags: DEFAULT_DEBUG_FLAGS,
      overlayVisible,
      applySnapshot: (snapshot) => set({ snapshot }),
      applyFlags: (flags) => set({ flags }),
      toggleFlag: (key) => set((s) => ({ flags: { ...s.flags, [key]: !s.flags[key] } })),
      setOverlayVisible: (overlayVisible_) => set({ overlayVisible: overlayVisible_ }),
      toggleOverlay: () => set((s) => ({ overlayVisible: !s.overlayVisible })),
    })),
  );
}

export const debugViewStore = createDebugViewStore();
export type DebugViewStore = ReturnType<typeof createDebugViewStore>;
