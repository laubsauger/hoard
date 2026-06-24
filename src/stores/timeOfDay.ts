// T126 / V1 / V11 / V91 — time-of-day VIEW + dev-override store. NOT persisted. Two directions, one store:
//   • the engine PUSHES `current` (the day fraction the LightingSystem used this frame) for the HUD clock;
//   • the dev sidebar WRITES `overrideEnabled` + `override`, which the RENDER-LANE lighting consults to park
//     the sun for tuning.
// This is a VIEW/dev override ONLY — the deterministic fixed-tick SIM clock is never touched (V2/V26), so
// replay stays exact and nothing in the sim reads it. B24/V11: every field is a PRIMITIVE — selectors return
// numbers/booleans, never fresh object/array literals.

import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';

function assertDayFraction(t: number): void {
  if (!Number.isFinite(t) || t < 0 || t > 1) throw new Error(`time-of-day fraction must be in [0,1], got ${t}`);
}

export interface TimeOfDayState {
  /** Day fraction 0..1 the lighting USED this frame (override if active, else the sim clock). Engine-pushed for the HUD readout. */
  readonly current: number;
  /** Dev override active — lighting uses `override` instead of the sim clock, freezing the day/night cycle. */
  readonly overrideEnabled: boolean;
  /** Dev-set day fraction 0..1 used while `overrideEnabled` (scrubbed from the sidebar slider). */
  readonly override: number;
  /** Engine: publish the effective day fraction for this frame (throttled by caller to minute granularity). */
  setCurrent(t: number): void;
  /** Dev: enable/disable the render-side phase override (freeze/unfreeze the day/night cycle for tuning). */
  setOverrideEnabled(on: boolean): void;
  /** Dev: scrub the override day fraction 0..1 (also implies override-on at the call site). */
  setOverride(t: number): void;
}

export function createTimeOfDayStore() {
  return createStore<TimeOfDayState>()(
    subscribeWithSelector((set) => ({
      current: 0,
      overrideEnabled: false,
      override: 0.5, // park at noon by default when first enabled (overwritten with the live time at enable time)
      setCurrent: (t) => {
        assertDayFraction(t);
        set({ current: t });
      },
      setOverrideEnabled: (overrideEnabled) => set({ overrideEnabled }),
      setOverride: (t) => {
        assertDayFraction(t);
        set({ override: t });
      },
    })),
  );
}

export const timeOfDayStore = createTimeOfDayStore();
export type TimeOfDayStore = typeof timeOfDayStore;
