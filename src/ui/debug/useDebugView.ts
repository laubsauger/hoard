// T35 / V11 — React bindings for the diagnostics overlay store. Every hook REQUIRES a selector so the
// overlay subscribes to the smallest practical slice. Reads ONLY the published aggregate snapshot +
// flags + visibility — never per-frame world arrays (V1).

import { useStore } from 'zustand';
import { debugViewStore, type DebugViewState } from '../../diagnostics/store';

export const useDebugView = <T>(selector: (s: DebugViewState) => T): T =>
  useStore(debugViewStore, selector);
