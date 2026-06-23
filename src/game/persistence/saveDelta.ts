// T14 / T33 / V9 / V26 — save delta capture + round-trip.
// A save = immutable base package (NOT stored here) + this compact delta of what the player/horde
// changed (V9). The delta records ONLY mutated state across the §I categories: structural breaches +
// strength (modules), functional mods / doors / barricades (functional), fires, breach list,
// obstructions, searched containers, moved persistent objects, corpses, dropped items, utility state,
// local-population changes, mission state — plus the IdFactory counter snapshot so post-load ids never
// collide (V26). Untouched base assets are never persisted (V9).
//
// Records carry an explicit schemaVersion (migrated forward on load, §schema.ts) plus the base-world
// version and optional asset version, validated for compatibility before applying (V23). Every cross-
// boundary reference is an explicit numeric/string ID, never a raw object ref (V26).

import type { CellDelta } from '@/game/destruction/structuralModule';
import type { FunctionalDelta } from '@/game/destruction/modifications';
import type { BurningCell } from '@/game/destruction/fire';
import type { NumericIdKind } from '@/game/core/contracts';
import { partitionId, type PartitionKey, type PersistenceAdapter } from './adapter';
import {
  CURRENT_SAVE_SCHEMA_VERSION,
  migrateToCurrent,
  registerMigration,
} from './schema';

/** Current save schema version (re-exported for back-compat; canonical value lives in schema.ts). */
export const SAVE_SCHEMA_VERSION = CURRENT_SAVE_SCHEMA_VERSION;

/** Per-structural-module modification delta (structural strength + breach state — V9/V18). */
export interface ModuleDelta {
  readonly module: number;
  readonly cells: CellDelta[];
}

/** Per-module compact fire state (burning cells — V18). */
export interface ModuleFireDelta {
  readonly module: number;
  readonly cells: BurningCell[];
}

/** A breach opening, addressed by explicit module + cell ids (V26). Derivable from modules, kept
 *  explicit so consumers (nav re-open, AI) need not re-scan every cell. */
export interface BreachRecord {
  readonly module: number;
  readonly cell: number;
}

/** A searched / looted container, addressed by its stable id (V26). */
export interface ContainerRecord {
  readonly container: number;
  readonly searched: boolean;
}

/** A persistent object the player moved, addressed by its stable id (V26). */
export interface MovedObjectRecord {
  readonly object: number;
  readonly x: number;
  readonly z: number;
  readonly rotation: number;
}

/** A dropped item resting in the world, addressed by its stable ItemId (V26). */
export interface DroppedItemRecord {
  readonly item: number;
  readonly x: number;
  readonly z: number;
}

/** A corpse, addressed by the entity it was (V26). */
export interface CorpseRecord {
  readonly entity: number;
  readonly x: number;
  readonly z: number;
  readonly atTick: number;
  // B9/T54 (additive): the toppled body's full transform + archetype + severed-region flags, so the corpse
  // render reconstructs the body and its dismemberment (missing limbs) persist. Optional — saves authored
  // before corpses carried a body shape omit these and default them on load (V23/V4, no invented state).
  readonly y?: number;
  readonly heading?: number;
  readonly archetype?: number;
  /** anatomyFlags sever bitfield at death (which regions were dismembered — V17 consequence persists). */
  readonly severedFlags?: number;
}

/** A utility node's state (power/water/alarm circuit), addressed by its stable id (V26). */
export interface UtilityRecord {
  readonly node: number;
  readonly powered: boolean;
}

/** Compact local-population delta for this partition (counts, not per-member base data — V9). */
export interface LocalPopulationDelta {
  readonly liveCount: number;
  readonly migratedIn: number;
  readonly migratedOut: number;
}

/** Mission/objective state keyed by explicit objective id (V26). */
export type MissionState = Readonly<Record<string, 'inactive' | 'active' | 'complete' | 'failed'>>;

/** IdFactory counter snapshot — restored on load so post-load ids never collide (V26). */
export type IdCounterSnapshot = Readonly<Record<NumericIdKind, number>>;

/** A compact, partition-scoped save delta. Only changed state — never untouched base assets (V9). */
export interface SaveDelta {
  readonly schemaVersion: number;
  /** Base-world package version this delta applies on top of (compat gate on load — V23). */
  readonly worldVersion: string;
  /** Optional asset-pack version this delta was authored against (compat gate on load — V23). */
  readonly assetVersion?: string;
  readonly district: number;
  readonly sector: number;
  readonly capturedAtTick: number;
  readonly modules: ModuleDelta[];
  readonly functional: FunctionalDelta[];
  readonly fires: ModuleFireDelta[];
  readonly breaches: BreachRecord[];
  readonly containers: ContainerRecord[];
  readonly movedObjects: MovedObjectRecord[];
  readonly droppedItems: DroppedItemRecord[];
  readonly corpses: CorpseRecord[];
  readonly utilities: UtilityRecord[];
  readonly population: LocalPopulationDelta | null;
  readonly missionState: MissionState;
  /** IdFactory counters at capture time (null = not captured — older saves). */
  readonly idCounters: IdCounterSnapshot | null;
}

/** Capture input. Only `worldVersion` / `partition` / `capturedAtTick` are required; every category
 *  defaults to "nothing changed" so callers persist exactly what they touched (V9). */
export interface SaveDeltaSource {
  readonly worldVersion: string;
  readonly assetVersion?: string;
  readonly partition: PartitionKey;
  readonly capturedAtTick: number;
  readonly modules?: ModuleDelta[];
  readonly functional?: FunctionalDelta[];
  readonly fires?: ModuleFireDelta[];
  readonly breaches?: BreachRecord[];
  readonly containers?: ContainerRecord[];
  readonly movedObjects?: MovedObjectRecord[];
  readonly droppedItems?: DroppedItemRecord[];
  readonly corpses?: CorpseRecord[];
  readonly utilities?: UtilityRecord[];
  readonly population?: LocalPopulationDelta | null;
  readonly missionState?: MissionState;
  readonly idCounters?: IdCounterSnapshot | null;
}

export function captureSaveDelta(src: SaveDeltaSource): SaveDelta {
  return {
    schemaVersion: CURRENT_SAVE_SCHEMA_VERSION,
    worldVersion: src.worldVersion,
    ...(src.assetVersion !== undefined ? { assetVersion: src.assetVersion } : {}),
    district: src.partition.district,
    sector: src.partition.sector,
    capturedAtTick: src.capturedAtTick,
    modules: (src.modules ?? []).map((m) => ({ module: m.module, cells: m.cells.map((c) => ({ ...c })) })),
    functional: (src.functional ?? []).map((f) => ({ ...f })),
    fires: (src.fires ?? []).map((f) => ({ module: f.module, cells: f.cells.map((c) => ({ ...c })) })),
    breaches: (src.breaches ?? []).map((b) => ({ ...b })),
    containers: (src.containers ?? []).map((c) => ({ ...c })),
    movedObjects: (src.movedObjects ?? []).map((o) => ({ ...o })),
    droppedItems: (src.droppedItems ?? []).map((d) => ({ ...d })),
    corpses: (src.corpses ?? []).map((c) => ({ ...c })),
    utilities: (src.utilities ?? []).map((u) => ({ ...u })),
    population: src.population ?? null,
    missionState: { ...(src.missionState ?? {}) },
    idCounters: src.idCounters ? { ...src.idCounters } : null,
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
 * Validate world + (optional) asset version compatibility of an already-migrated delta. Throws
 * SaveCompatError on mismatch (V23) — a stale or foreign save is rejected explicitly, never coerced.
 * Asset version is only checked when the caller supplies an expectation AND the record carries one;
 * a caller that demands an asset version against a record lacking one is a hard mismatch.
 */
export function validateSaveCompat(
  delta: SaveDelta,
  expectedWorldVersion: string,
  expectedAssetVersion?: string,
): void {
  if (delta.worldVersion !== expectedWorldVersion) {
    throw new SaveCompatError(`save world version '${delta.worldVersion}' != expected '${expectedWorldVersion}'`);
  }
  if (expectedAssetVersion !== undefined) {
    if (delta.assetVersion === undefined) {
      throw new SaveCompatError(`save has no asset version but '${expectedAssetVersion}' was required`);
    }
    if (delta.assetVersion !== expectedAssetVersion) {
      throw new SaveCompatError(`save asset version '${delta.assetVersion}' != expected '${expectedAssetVersion}'`);
    }
  }
}

/**
 * Migrate a raw stored record forward to the current schema (§schema.ts). Future versions and
 * corrupt/version-less records throw (V23). The migrated object satisfies the current SaveDelta shape.
 */
export function migrateSaveDelta(raw: unknown): SaveDelta {
  if (typeof raw !== 'object' || raw === null) {
    throw new SaveCompatError('save record is not an object');
  }
  const migrated = migrateToCurrent(raw as Record<string, unknown>);
  return migrated as unknown as SaveDelta;
}

/**
 * Read + migrate + validate a save delta. Older schema versions are migrated forward; future
 * versions are rejected (V23). World/asset compatibility is validated before the delta is returned.
 * Returns null when no save exists for the partition.
 */
export async function readSaveDelta(
  adapter: PersistenceAdapter,
  partition: PartitionKey,
  expectedWorldVersion: string,
  expectedAssetVersion?: string,
): Promise<SaveDelta | null> {
  const raw = await adapter.get<unknown>(partition, saveDeltaKey(partition));
  if (raw === null) return null;
  const delta = migrateSaveDelta(raw);
  validateSaveCompat(delta, expectedWorldVersion, expectedAssetVersion);
  return delta;
}

// ---- migrations (registered from the first public build) ----

/** v1 -> v2: the first public build stored only structural module deltas. v2 added the full §I
 *  category set + IdFactory counter snapshot. Absent categories migrate to "nothing changed". */
registerMigration(1, (record) => ({
  ...record,
  schemaVersion: 2,
  modules: Array.isArray(record.modules) ? record.modules : [],
  functional: [],
  fires: [],
  breaches: [],
  containers: [],
  movedObjects: [],
  droppedItems: [],
  corpses: [],
  utilities: [],
  population: null,
  missionState: {},
  idCounters: null,
}));
