// T41 / V9 / V23 / V26 — runtime save record (forward-pulled subset of T33).
// Sits ALONGSIDE the lane-S structural SaveDelta (which carries breach/module deltas). This record
// carries the two pieces the structural delta does not: the IdFactory counters (so post-load ids never
// collide — V26) and the compact live population (entity id + archetype + transform + health/anatomy).
// Both are pure delta on top of the immutable base block (V9) — the base geometry is rebuilt, never stored.

import type { NumericIdKind } from '@/game/core/contracts';

export const RUNTIME_SAVE_SCHEMA_VERSION = 1;
export const RUNTIME_SAVE_KEY = 'runtime:gate0';

/** One live zombie, addressed by its stable EntityId across the persistence boundary (V26). */
export interface PopulationEntry {
  readonly entity: number;
  readonly archetype: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  readonly state: number;
  readonly health: number;
  readonly anatomyFlags: number;
  readonly navGroup: number;
}

export interface RuntimeSave {
  readonly schemaVersion: number;
  readonly worldVersion: string;
  readonly capturedAtTick: number;
  /** IdFactory counters so the next mint after load is beyond every restored id (V26). */
  readonly idCounters: Record<NumericIdKind, number>;
  readonly population: readonly PopulationEntry[];
}
