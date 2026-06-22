// T33 / V23 — periodic checkpoints + short mutation journal for crash recovery.
// A checkpoint is a full partition SaveDelta written as ONE atomic record. Between checkpoints, fine-
// grained changes append to a short mutation journal (one record per entry). On load we take the
// latest VALID checkpoint and replay the journal atop it; if the latest checkpoint is corrupt we fall
// back to the previous retained checkpoint (V23 — retain previous valid, never corrupt authoritative
// state). Pointer flips happen AFTER the data they reference is written, so a crash mid-write always
// leaves a consistent, loadable state. Partitions are independent: one corrupt partition cannot break
// another (loadAll isolates failures). Cadence + journal length + retention come from typed config (V4).

import { savingConfig } from '@/config/domains/saving';
import type { ResolvedDomain } from '@/config/types';
import { partitionId, type PartitionKey, type PersistenceAdapter } from './adapter';
import {
  captureSaveDelta,
  migrateSaveDelta,
  validateSaveCompat,
  type BreachRecord,
  type ContainerRecord,
  type CorpseRecord,
  type DroppedItemRecord,
  type IdCounterSnapshot,
  type LocalPopulationDelta,
  type MissionState,
  type ModuleDelta,
  type ModuleFireDelta,
  type MovedObjectRecord,
  type SaveDelta,
  type UtilityRecord,
} from './saveDelta';

export type SavingSettings = ResolvedDomain<typeof savingConfig>;

const POINTER_KEY = 'save:pointer';
const checkpointKey = (seq: number): string => `save:checkpoint:${seq}`;
const journalKey = (seq: number): string => `save:journal:${seq}`;

interface SavePointer {
  /** Highest written checkpoint seq for this partition (0 = none). */
  readonly checkpointSeq: number;
  /** Journal entries 1..journalSeq belong to the latest checkpoint era (0 = empty journal). */
  readonly journalSeq: number;
}

/** A compact mutation recorded between checkpoints. Only the categories that changed are present. */
export interface SaveDeltaFragment {
  readonly modules?: ModuleDelta[];
  readonly fires?: ModuleFireDelta[];
  readonly functional?: SaveDelta['functional'];
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

interface JournalEntry {
  readonly seq: number;
  readonly atTick: number;
  readonly fragment: SaveDeltaFragment;
}

export class PartitionCorruptError extends Error {
  constructor(partition: PartitionKey, detail: string) {
    super(`partition ${partitionId(partition)} has no valid checkpoint: ${detail}`);
    this.name = 'PartitionCorruptError';
  }
}

/** Compat target validated against every loaded checkpoint (V23). */
export interface CompatTarget {
  readonly worldVersion: string;
  readonly assetVersion?: string;
}

/** Result of loading every requested partition — failures are isolated, never propagated (V23). */
export interface LoadAllResult {
  readonly loaded: Map<string, SaveDelta>;
  readonly corrupt: PartitionKey[];
}

/** Overwrite entries of an array by a string key (incoming wins; base entries without a match kept). */
function overwriteById<T>(base: readonly T[], incoming: readonly T[] | undefined, key: (t: T) => string): T[] {
  if (!incoming || incoming.length === 0) return base.map((b) => ({ ...b }));
  const map = new Map<string, T>();
  for (const b of base) map.set(key(b), b);
  for (const i of incoming) map.set(key(i), i);
  return [...map.values()].map((v) => ({ ...v }));
}

/** Fold one journal fragment atop a base delta, producing the recovered state (pure). */
export function foldFragment(base: SaveDelta, frag: SaveDeltaFragment, atTick: number): SaveDelta {
  return {
    ...base,
    capturedAtTick: atTick,
    modules: overwriteById(base.modules, frag.modules, (m) => String(m.module)),
    fires: overwriteById(base.fires, frag.fires, (f) => String(f.module)),
    functional: overwriteById(base.functional, frag.functional, (f) => `${f.module}:${f.cell}`),
    breaches: overwriteById(base.breaches, frag.breaches, (b) => `${b.module}:${b.cell}`),
    containers: overwriteById(base.containers, frag.containers, (c) => String(c.container)),
    movedObjects: overwriteById(base.movedObjects, frag.movedObjects, (o) => String(o.object)),
    droppedItems: overwriteById(base.droppedItems, frag.droppedItems, (d) => String(d.item)),
    corpses: overwriteById(base.corpses, frag.corpses, (c) => String(c.entity)),
    utilities: overwriteById(base.utilities, frag.utilities, (u) => String(u.node)),
    population: frag.population !== undefined ? frag.population : base.population,
    missionState: frag.missionState ? { ...base.missionState, ...frag.missionState } : base.missionState,
    idCounters: frag.idCounters !== undefined ? frag.idCounters : base.idCounters,
  };
}

/**
 * Per-partition checkpoint + journal store with crash recovery. One instance serves all partitions of
 * one save slot; per-partition records are namespaced so partitions never collide (V23 isolation).
 */
export class SaveManager {
  readonly settings: SavingSettings;
  private readonly adapter: PersistenceAdapter;
  private readonly compat: CompatTarget;

  constructor(adapter: PersistenceAdapter, compat: CompatTarget, settings: SavingSettings) {
    this.adapter = adapter;
    this.compat = compat;
    this.settings = settings;
  }

  private async pointer(p: PartitionKey): Promise<SavePointer | null> {
    return this.adapter.get<SavePointer>(p, POINTER_KEY);
  }

  /**
   * Write a full checkpoint for a partition. The data record is written FIRST, then the pointer flips
   * to it, then stale journal + over-retention checkpoints are pruned. A crash before the pointer flip
   * leaves the previous checkpoint authoritative (V23). Returns the new checkpoint seq.
   */
  async writeCheckpoint(delta: SaveDelta): Promise<number> {
    const p: PartitionKey = { district: delta.district, sector: delta.sector };
    const prev = await this.pointer(p);
    const seq = (prev?.checkpointSeq ?? 0) + 1;

    await this.adapter.put(p, checkpointKey(seq), delta); // atomic data record
    await this.adapter.put(p, POINTER_KEY, { checkpointSeq: seq, journalSeq: 0 } satisfies SavePointer); // flip

    // cleanup: orphaned journal of the previous era + checkpoints beyond retention.
    if (prev) {
      for (let i = 1; i <= prev.journalSeq; i++) await this.adapter.delete(p, journalKey(i));
    }
    const prune = seq - this.settings.retainedCheckpoints;
    if (prune >= 1) await this.adapter.delete(p, checkpointKey(prune));
    return seq;
  }

  /**
   * Append a mutation to a partition's journal. Requires an existing checkpoint. When the journal
   * reaches `journalMaxEntries`, it is compacted into a fresh checkpoint (replay + re-snapshot).
   */
  async appendMutation(p: PartitionKey, fragment: SaveDeltaFragment, atTick: number): Promise<void> {
    const ptr = await this.pointer(p);
    if (!ptr || ptr.checkpointSeq === 0) {
      throw new Error(`cannot journal partition ${partitionId(p)} before its first checkpoint`);
    }
    const seq = ptr.journalSeq + 1;
    await this.adapter.put(p, journalKey(seq), { seq, atTick, fragment } satisfies JournalEntry);
    await this.adapter.put(p, POINTER_KEY, { checkpointSeq: ptr.checkpointSeq, journalSeq: seq } satisfies SavePointer);

    if (seq >= this.settings.journalMaxEntries) {
      const recovered = await this.load(p);
      if (recovered) await this.writeCheckpoint(recovered);
    }
  }

  /** Find the newest valid checkpoint for a partition, scanning back through retained ones (V23). */
  private async loadValidCheckpoint(
    p: PartitionKey,
    ptr: SavePointer,
  ): Promise<{ seq: number; delta: SaveDelta } | null> {
    const oldest = Math.max(1, ptr.checkpointSeq - this.settings.retainedCheckpoints + 1);
    let detail = 'no checkpoint records';
    for (let seq = ptr.checkpointSeq; seq >= oldest; seq--) {
      const raw = await this.adapter.get<unknown>(p, checkpointKey(seq));
      if (raw === null) continue;
      try {
        const delta = migrateSaveDelta(raw);
        validateSaveCompat(delta, this.compat.worldVersion, this.compat.assetVersion);
        return { seq, delta };
      } catch (e) {
        detail = `checkpoint ${seq}: ${(e as Error).message}`;
      }
    }
    void detail;
    return null;
  }

  /**
   * Recover a partition's authoritative state: newest valid checkpoint + journal replay. If the latest
   * checkpoint is corrupt we fall back to the previous retained checkpoint WITHOUT replaying its journal
   * (the journal belongs to the corrupt era). Throws PartitionCorruptError if no checkpoint is valid.
   * Returns null only when the partition has never been saved.
   */
  async load(p: PartitionKey): Promise<SaveDelta | null> {
    const ptr = await this.pointer(p);
    if (!ptr || ptr.checkpointSeq === 0) return null;

    const found = await this.loadValidCheckpoint(p, ptr);
    if (!found) throw new PartitionCorruptError(p, 'all retained checkpoints failed migration/compat');

    // Only replay the journal when the LATEST checkpoint is the one we loaded.
    if (found.seq !== ptr.checkpointSeq) return found.delta;

    let delta = found.delta;
    for (let i = 1; i <= ptr.journalSeq; i++) {
      const raw = await this.adapter.get<JournalEntry>(p, journalKey(i));
      if (raw === null) break; // gap — stop; later entries cannot be applied in order
      delta = foldFragment(delta, raw.fragment, raw.atTick);
    }
    return delta;
  }

  /** Load many partitions independently; corrupt partitions are isolated, not fatal (V23). */
  async loadAll(partitions: readonly PartitionKey[]): Promise<LoadAllResult> {
    const loaded = new Map<string, SaveDelta>();
    const corrupt: PartitionKey[] = [];
    for (const p of partitions) {
      try {
        const delta = await this.load(p);
        if (delta) loaded.set(partitionId(p), delta);
      } catch {
        corrupt.push(p);
      }
    }
    return { loaded, corrupt };
  }
}

/** Resolve the saving config for a tier and build a SaveManager (convenience for callers). */
export function createSaveManager(
  adapter: PersistenceAdapter,
  compat: CompatTarget,
  settings: SavingSettings,
): SaveManager {
  return new SaveManager(adapter, compat, settings);
}

/** Build an empty checkpoint delta for a partition (no mutations yet) — convenience for first save. */
export function emptyCheckpoint(partition: PartitionKey, worldVersion: string, capturedAtTick: number): SaveDelta {
  return captureSaveDelta({ worldVersion, partition, capturedAtTick });
}
