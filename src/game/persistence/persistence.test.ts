// T14 tests — V9 (base separate from delta), delta round-trip, version-compat (V23),
// IndexedDB adapter structured-not-faked (V4) in Node.

import { describe, it, expect } from 'vitest';
import { InMemoryPersistenceAdapter } from './memoryAdapter';
import { IndexedDbPersistenceAdapter, IndexedDbUnavailableError } from './indexedDbAdapter';
import {
  captureSaveDelta,
  writeSaveDelta,
  readSaveDelta,
  SaveCompatError,
  SAVE_SCHEMA_VERSION,
  type ModuleDelta,
} from './saveDelta';
import type { PartitionKey } from './adapter';
import { StructuralModule, type StructuralHooks } from '@/game/destruction/structuralModule';
import { IdFactory } from '@/game/core/ids';
import type { EventId, ModuleId, WorldEvent } from '@/game/core/contracts';

const PARTITION: PartitionKey = { district: 2, sector: 5 };
const WORLD_VERSION = 'base-1.0.0';

function moduleWithBreach(): ModuleDelta {
  const m = new StructuralModule({ id: 1 as ModuleId, sizeX: 4, sizeY: 1, sizeZ: 1, seed: 3 });
  for (let x = 0; x < 4; x++) m.addCell({ x, y: 0, z: 0, material: 'wood', family: 0, strength: 50 });
  const ids = new IdFactory();
  const events: WorldEvent[] = [];
  const hooks: StructuralHooks = { nextEventId: () => ids.next<EventId>('event'), emit: (e) => events.push(e) };
  m.applyDamage(m.packCell(1, 0, 0), 50, hooks);
  return { module: 1, cells: m.modificationDelta() };
}

describe('InMemoryPersistenceAdapter', () => {
  it('partitions records and round-trips values', async () => {
    const a = new InMemoryPersistenceAdapter();
    await a.put(PARTITION, 'k', { hello: 1 });
    expect(await a.get(PARTITION, 'k')).toEqual({ hello: 1 });
    expect(await a.get({ district: 9, sector: 9 }, 'k')).toBeNull(); // isolated partition
    expect(await a.list(PARTITION)).toEqual(['k']);
    await a.delete(PARTITION, 'k');
    expect(await a.get(PARTITION, 'k')).toBeNull();
  });

  it('stores by value, not by reference (structured-clone boundary)', async () => {
    const a = new InMemoryPersistenceAdapter();
    const obj = { n: 1 };
    await a.put(PARTITION, 'k', obj);
    obj.n = 999; // mutate after store
    expect(await a.get<{ n: number }>(PARTITION, 'k')).toEqual({ n: 1 });
  });
});

describe('save delta capture + round-trip (V9/V23)', () => {
  it('captures only modified state and round-trips through the adapter', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const delta = captureSaveDelta({
      worldVersion: WORLD_VERSION,
      partition: PARTITION,
      capturedAtTick: 1234,
      modules: [moduleWithBreach()],
    });
    expect(delta.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(delta.modules[0]!.cells.some((c) => c.breached)).toBe(true);

    await writeSaveDelta(adapter, delta);
    const loaded = await readSaveDelta(adapter, PARTITION, WORLD_VERSION);
    expect(loaded).not.toBeNull();
    expect(loaded!.modules[0]!.cells).toEqual(delta.modules[0]!.cells);
    expect(loaded!.capturedAtTick).toBe(1234);
  });

  it('reapplying the loaded delta restores the breached module state', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const delta = captureSaveDelta({
      worldVersion: WORLD_VERSION,
      partition: PARTITION,
      capturedAtTick: 1,
      modules: [moduleWithBreach()],
    });
    await writeSaveDelta(adapter, delta);
    const loaded = (await readSaveDelta(adapter, PARTITION, WORLD_VERSION))!;

    // rebuild the base module (no breach) then apply the saved delta
    const rebuilt = new StructuralModule({ id: 1 as ModuleId, sizeX: 4, sizeY: 1, sizeZ: 1, seed: 3 });
    for (let x = 0; x < 4; x++) rebuilt.addCell({ x, y: 0, z: 0, material: 'wood', family: 0, strength: 50 });
    rebuilt.applyDeltaSnapshot(loaded.modules[0]!.cells);
    expect(rebuilt.isBreached(rebuilt.packCell(1, 0, 0))).toBe(true);
  });

  it('rejects an incompatible world version (V23 — explicit, no silent coercion)', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const delta = captureSaveDelta({
      worldVersion: WORLD_VERSION,
      partition: PARTITION,
      capturedAtTick: 1,
      modules: [],
    });
    await writeSaveDelta(adapter, delta);
    await expect(readSaveDelta(adapter, PARTITION, 'base-2.0.0')).rejects.toBeInstanceOf(SaveCompatError);
  });

  it('returns null for an absent save', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    expect(await readSaveDelta(adapter, PARTITION, WORLD_VERSION)).toBeNull();
  });
});

describe('IndexedDbPersistenceAdapter (R14) — structured, not faked', () => {
  it('throws a clear error when constructed without indexedDB (Node)', () => {
    expect(() => new IndexedDbPersistenceAdapter()).toThrow(IndexedDbUnavailableError);
  });
});
