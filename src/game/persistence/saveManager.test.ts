// T33 tests — checkpoints + mutation journal crash recovery (V23): journal replay atop the last good
// checkpoint, fall back to the previous valid checkpoint when the latest is corrupt, partition
// isolation (one corrupt partition does not break others), journal compaction, and the pure fold.

import { describe, it, expect } from 'vitest';
import { resolveDomain } from '@/config/registry';
import { savingConfig } from '@/config/domains/saving';
import { InMemoryPersistenceAdapter } from './memoryAdapter';
import {
  SaveManager,
  foldFragment,
  PartitionCorruptError,
  type SavingSettings,
} from './checkpoint';
import { captureSaveDelta, type SaveDelta } from './saveDelta';
import { partitionId, type PartitionKey } from './adapter';

const WORLD = 'base-1.0.0';
const P1: PartitionKey = { district: 1, sector: 0 };
const P2: PartitionKey = { district: 2, sector: 0 };
const SETTINGS: SavingSettings = resolveDomain(savingConfig, 'desktop-high');

function deltaFor(p: PartitionKey, tick: number, extra: Partial<Parameters<typeof captureSaveDelta>[0]> = {}): SaveDelta {
  return captureSaveDelta({ worldVersion: WORLD, partition: p, capturedAtTick: tick, ...extra });
}

describe('SaveManager — checkpoint + journal recovery (V23)', () => {
  it('replays the journal atop the latest checkpoint to restore post-checkpoint mutations', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const mgr = new SaveManager(adapter, { worldVersion: WORLD }, SETTINGS);

    await mgr.writeCheckpoint(deltaFor(P1, 10, {
      modules: [{ module: 1, cells: [{ cell: 0, strength: 0, breached: true }] }],
    }));
    // post-checkpoint: a fire starts + a container is searched.
    await mgr.appendMutation(P1, {
      fires: [{ module: 1, cells: [{ cell: 5, fuel: 3, intensity: 0.5, burning: true }] }],
    }, 20);
    await mgr.appendMutation(P1, { containers: [{ container: 99, searched: true }] }, 30);

    const recovered = (await mgr.load(P1))!;
    expect(recovered.modules[0]!.cells[0]!.breached).toBe(true); // checkpoint state preserved
    expect(recovered.fires[0]!.cells[0]!.cell).toBe(5); // journal mutation 1
    expect(recovered.containers).toEqual([{ container: 99, searched: true }]); // journal mutation 2
    expect(recovered.capturedAtTick).toBe(30); // latest journal tick
  });

  it('falls back to the previous valid checkpoint when the latest is corrupt (retain previous — V23)', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const mgr = new SaveManager(adapter, { worldVersion: WORLD }, SETTINGS);

    await mgr.writeCheckpoint(deltaFor(P1, 100, { population: { liveCount: 5, migratedIn: 0, migratedOut: 0 } }));
    await mgr.writeCheckpoint(deltaFor(P1, 200, { population: { liveCount: 9, migratedIn: 4, migratedOut: 0 } }));

    // simulate a torn / corrupt latest checkpoint record.
    await adapter.put(P1, 'save:checkpoint:2', { junk: true });

    const recovered = (await mgr.load(P1))!;
    expect(recovered.capturedAtTick).toBe(100); // previous valid checkpoint
    expect(recovered.population).toEqual({ liveCount: 5, migratedIn: 0, migratedOut: 0 });
  });

  it('throws PartitionCorruptError when no retained checkpoint is valid', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const mgr = new SaveManager(adapter, { worldVersion: WORLD }, SETTINGS);
    await mgr.writeCheckpoint(deltaFor(P1, 1));
    await adapter.put(P1, 'save:checkpoint:1', { junk: true });
    await expect(mgr.load(P1)).rejects.toBeInstanceOf(PartitionCorruptError);
  });

  it('returns null for a never-saved partition and refuses to journal before a checkpoint', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const mgr = new SaveManager(adapter, { worldVersion: WORLD }, SETTINGS);
    expect(await mgr.load(P1)).toBeNull();
    await expect(mgr.appendMutation(P1, { containers: [] }, 1)).rejects.toThrow();
  });

  it('compacts the journal into a fresh checkpoint at journalMaxEntries', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const small: SavingSettings = { ...SETTINGS, journalMaxEntries: 3 };
    const mgr = new SaveManager(adapter, { worldVersion: WORLD }, small);

    await mgr.writeCheckpoint(deltaFor(P1, 0));
    for (let i = 1; i <= 3; i++) {
      await mgr.appendMutation(P1, { utilities: [{ node: i, powered: false }] }, i * 10);
    }
    // after compaction the journal is folded into a new checkpoint; state survives a reload.
    const recovered = (await mgr.load(P1))!;
    expect(recovered.utilities.map((u) => u.node).sort()).toEqual([1, 2, 3]);
    // a follow-up mutation atop the compacted checkpoint still applies.
    await mgr.appendMutation(P1, { utilities: [{ node: 4, powered: true }] }, 40);
    const after = (await mgr.load(P1))!;
    expect(after.utilities.some((u) => u.node === 4 && u.powered)).toBe(true);
  });
});

describe('SaveManager — partition isolation (V23)', () => {
  it('loads good partitions and isolates a corrupt one', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const mgr = new SaveManager(adapter, { worldVersion: WORLD }, SETTINGS);

    await mgr.writeCheckpoint(deltaFor(P1, 11));
    await mgr.writeCheckpoint(deltaFor(P2, 22));
    // destroy P2's only checkpoint — P1 must be unaffected.
    await adapter.put(P2, 'save:checkpoint:1', { junk: true });

    const result = await mgr.loadAll([P1, P2]);
    expect(result.loaded.has(partitionId(P1))).toBe(true);
    expect(result.loaded.get(partitionId(P1))!.capturedAtTick).toBe(11);
    expect(result.loaded.has(partitionId(P2))).toBe(false);
    expect(result.corrupt.map(partitionId)).toEqual([partitionId(P2)]);
  });
});

describe('foldFragment (pure journal replay)', () => {
  it('overwrites by id and merges mission state without touching unrelated categories', () => {
    const base = captureSaveDelta({
      worldVersion: WORLD,
      partition: P1,
      capturedAtTick: 1,
      containers: [{ container: 1, searched: false }, { container: 2, searched: false }],
      missionState: { a: 'active' },
    });
    const folded = foldFragment(base, {
      containers: [{ container: 1, searched: true }], // overwrite container 1 only
      missionState: { b: 'complete' },
    }, 5);

    expect(folded.capturedAtTick).toBe(5);
    expect(folded.containers).toEqual([
      { container: 1, searched: true },
      { container: 2, searched: false },
    ]);
    expect(folded.missionState).toEqual({ a: 'active', b: 'complete' });
    expect(base.containers[0]!.searched).toBe(false); // base untouched (pure)
  });
});
