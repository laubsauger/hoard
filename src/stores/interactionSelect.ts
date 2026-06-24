// T113 / V11 / V43 — interaction OPTION-SELECTION state. The mouse WHEEL cycles which of the nearest
// interactable's gated verbs is SELECTED (wrap-around); tapping the interact key (F) executes the SELECTED one
// (default = the headline/first verb). State is held as PRIMITIVES only (selectedIndex + verbCount) so every
// React selector returns a scalar — never a fresh object/array literal, which would break the cached-snapshot
// rule and crash with "getSnapshot should be cached" (B24/V11). The wheel publishes the LIVE verb count (verbs
// change with state — a window's verbs differ boarded vs open), which CLAMPS the index into range; the input
// handler reads `verbCount` to decide whether the wheel drives selection (count>0) or the camera zoom (count===0).

import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';

/** Wrap `current` by `dir` within [0,count): pure + deterministic. Returns 0 when there are no verbs. */
export function cycleIndex(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return 0;
  return (((current + dir) % count) + count) % count;
}

/** Clamp `current` into [0,count): pure. Returns 0 when there are no verbs (nothing selectable). */
export function clampIndex(current: number, count: number): number {
  if (count <= 0) return 0;
  if (current < 0) return 0;
  if (current >= count) return count - 1;
  return current;
}

export interface InteractionSelectState {
  /** Index of the highlighted verb among the nearest target's gated verbs (0 = headline). */
  readonly selectedIndex: number;
  /** Live count of gated verbs offered by the nearest target in reach (0 = nothing interactable). */
  readonly verbCount: number;
  /** Publish the live verb-list size; CLAMPS selectedIndex into the new range (verbs changed). */
  setVerbCount(count: number): void;
  /** Cycle the selection by one step within verbCount (wrap). No-op when verbCount===0. */
  cycle(dir: 1 | -1): void;
  /** Reset selection to the headline verb (index 0). */
  reset(): void;
}

export function createInteractionSelectStore() {
  return createStore<InteractionSelectState>()(
    subscribeWithSelector((set, get) => ({
      selectedIndex: 0,
      verbCount: 0,
      setVerbCount: (count) => {
        const c = Math.max(0, Math.floor(count));
        const clamped = clampIndex(get().selectedIndex, c);
        // Write only on an actual change so polling each frame never churns the store (V11).
        if (c !== get().verbCount || clamped !== get().selectedIndex) set({ verbCount: c, selectedIndex: clamped });
      },
      cycle: (dir) => set((s) => ({ selectedIndex: cycleIndex(s.selectedIndex, s.verbCount, dir) })),
      reset: () => {
        if (get().selectedIndex !== 0) set({ selectedIndex: 0 });
      },
    })),
  );
}

export const interactionSelectStore = createInteractionSelectStore();
export type InteractionSelectStore = typeof interactionSelectStore;
