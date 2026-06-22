// T41 / T40 / V9 / V23 / V26 — runtime save record (forward-pulled subset of T33).
// Sits ALONGSIDE the lane-S structural SaveDelta (which carries breach/module deltas). This record
// carries the pieces the structural delta does not: the IdFactory counters (so post-load ids never
// collide — V26), the compact live population (entity id + archetype + transform + health/anatomy), and
// (M2) the medium-term objective state + per-sector abstract district population. All are pure delta on
// top of the immutable base block (V9) — the base geometry is rebuilt, never stored.
//
// Schema v1 = GATE-0/M1 (population + player + weather). v2 = M2 (adds objective + district). A v1 record
// migrates forward by defaulting the new fields (migrateRuntimeSave), so old saves still load (V23).

import type { NumericIdKind } from '@/game/core/contracts';
import type { ObjectiveSave } from '@/game/objective';
import type { SectorPopulationSave } from '@/game/world';

export const RUNTIME_SAVE_SCHEMA_VERSION = 2;
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

/** Player avatar transform persisted with the slice (T38). */
export interface PlayerSave {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
}

export interface RuntimeSave {
  readonly schemaVersion: number;
  readonly worldVersion: string;
  readonly capturedAtTick: number;
  /** IdFactory counters so the next mint after load is beyond every restored id (V26). */
  readonly idCounters: Record<NumericIdKind, number>;
  readonly population: readonly PopulationEntry[];
  /** Player avatar transform (T38 slice). Optional for backward compatibility with GATE-0 saves. */
  readonly player?: PlayerSave;
  /** Active weather profile id (T38 slice). Optional for backward compatibility. */
  readonly weather?: string;
  /** Medium-term objective state (M2 / schema v2). Absent in v1 saves → defaults on migrate. */
  readonly objective?: ObjectiveSave;
  /** Per-sector abstract district population (M2 / schema v2). Absent in v1 saves → empty on migrate. */
  readonly district?: readonly SectorPopulationSave[];
}

/**
 * Migrate a raw runtime-save record forward to the current schema (V23). A v1 record (M1) gains the M2
 * fields as absent (the runtime re-seeds defaults on restore); a future version is rejected by the
 * caller. Returns a record at the current schema version. No invented gameplay fallbacks (V4) — absent
 * objective/district simply means "start fresh for those subsystems".
 */
export function migrateRuntimeSave(record: RuntimeSave): RuntimeSave {
  if (record.schemaVersion === RUNTIME_SAVE_SCHEMA_VERSION) return record;
  if (record.schemaVersion === 1) {
    return { ...record, schemaVersion: RUNTIME_SAVE_SCHEMA_VERSION };
  }
  throw new Error(`unknown runtime-save schema version ${record.schemaVersion}`);
}
