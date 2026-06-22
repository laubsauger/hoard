// T14 / V9 / V26 — save delta capture + round-trip.
// A save = immutable base package (NOT stored here) + this compact delta of what the player/horde
// changed (V9). Records carry a schema version + world version so a load can validate compatibility
// before applying (V23). Partitioned by district/sector (§I).

import type { CellDelta } from '@/game/destruction/structuralModule';
import { partitionId, type PartitionKey, type PersistenceAdapter } from './adapter';

export const SAVE_SCHEMA_VERSION = 1;

/** Per-structural-module modification delta. */
export interface ModuleDelta {
  readonly module: number;
  readonly cells: CellDelta[];
}

/** A compact, partition-scoped save delta. Only changed state — never untouched base assets (V9). */
export interface SaveDelta {
  readonly schemaVersion: number;
  /** Base-world package version this delta applies on top of (compat gate on load — V23). */
  readonly worldVersion: string;
  readonly district: number;
  readonly sector: number;
  readonly capturedAtTick: number;
  readonly modules: ModuleDelta[];
}

export interface SaveDeltaSource {
  readonly worldVersion: string;
  readonly partition: PartitionKey;
  readonly capturedAtTick: number;
  readonly modules: ModuleDelta[];
}

export function captureSaveDelta(src: SaveDeltaSource): SaveDelta {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    worldVersion: src.worldVersion,
    district: src.partition.district,
    sector: src.partition.sector,
    capturedAtTick: src.capturedAtTick,
    modules: src.modules.map((m) => ({ module: m.module, cells: m.cells.map((c) => ({ ...c })) })),
  };
}

/** Storage key for a save delta within its partition. */
export function saveDeltaKey(partition: PartitionKey): string {
  return `delta:${partitionId(partition)}`;
}

export async function writeSaveDelta(adapter: PersistenceAdapter, delta: SaveDelta): Promise<void> {
  const partition: PartitionKey = { district: delta.district, sector: delta.sector };
  await adapter.put(partition, saveDeltaKey(partition), delta);
}

export class SaveCompatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveCompatError';
  }
}

/**
 * Read + validate a save delta. Throws SaveCompatError on schema/world-version mismatch (V23) — a
 * stale or foreign save is rejected explicitly, never silently coerced.
 */
export async function readSaveDelta(
  adapter: PersistenceAdapter,
  partition: PartitionKey,
  expectedWorldVersion: string,
): Promise<SaveDelta | null> {
  const delta = await adapter.get<SaveDelta>(partition, saveDeltaKey(partition));
  if (delta === null) return null;
  if (delta.schemaVersion !== SAVE_SCHEMA_VERSION) {
    throw new SaveCompatError(`save schema ${delta.schemaVersion} != expected ${SAVE_SCHEMA_VERSION}`);
  }
  if (delta.worldVersion !== expectedWorldVersion) {
    throw new SaveCompatError(`save world version '${delta.worldVersion}' != expected '${expectedWorldVersion}'`);
  }
  return delta;
}
