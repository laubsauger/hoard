// T33 tests — schema versioning + migration (V23), world/asset compat rejection (V23), full-category
// base-vs-delta round-trip (V9), IdFactory counter restore prevents post-load id collision (V26).

import { describe, it, expect } from 'vitest';
import { InMemoryPersistenceAdapter } from './memoryAdapter';
import {
  captureSaveDelta,
  writeSaveDelta,
  readSaveDelta,
  saveDeltaKey,
  validateSaveCompat,
  migrateSaveDelta,
  SaveCompatError,
  CURRENT_SAVE_SCHEMA_VERSION,
  type SaveDelta,
  type IdCounterSnapshot,
} from './index';
import { SchemaError } from './schema';
import type { PartitionKey } from './adapter';
import { IdFactory } from '@/game/core/ids';

const PARTITION: PartitionKey = { district: 2, sector: 5 };
const WORLD = 'base-1.0.0';
const ASSET = 'assets-1.4.0';

describe('full-category base-vs-delta round-trip (V9)', () => {
  it('captures + restores every §I modification category and the id counters', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const ids = new IdFactory();
    ids.next('event'); ids.next('event'); ids.next('entity');
    const counters = ids.snapshot();

    const delta = captureSaveDelta({
      worldVersion: WORLD,
      assetVersion: ASSET,
      partition: PARTITION,
      capturedAtTick: 42,
      modules: [{ module: 1, cells: [{ cell: 3, strength: 0, breached: true }] }],
      functional: [{ module: 1, cell: 7, access: 'locked', boarded: true, obstructed: false }],
      fires: [{ module: 1, cells: [{ cell: 9, fuel: 5, intensity: 0.7, burning: true }] }],
      breaches: [{ module: 1, cell: 3 }],
      containers: [{ container: 100, searched: true }],
      movedObjects: [{ object: 200, x: 1, z: 2, rotation: 90 }],
      droppedItems: [{ item: 300, x: 3, z: 4 }],
      corpses: [{ entity: 400, x: 5, z: 6, atTick: 40 }],
      utilities: [{ node: 500, powered: false }],
      population: { liveCount: 12, migratedIn: 3, migratedOut: 1 },
      missionState: { rescue: 'active', loot: 'complete' },
      idCounters: counters,
    });

    await writeSaveDelta(adapter, delta);
    const loaded = (await readSaveDelta(adapter, PARTITION, WORLD, ASSET))!;

    expect(loaded.schemaVersion).toBe(CURRENT_SAVE_SCHEMA_VERSION);
    expect(loaded.modules).toEqual(delta.modules);
    expect(loaded.functional).toEqual(delta.functional);
    expect(loaded.fires).toEqual(delta.fires);
    expect(loaded.breaches).toEqual(delta.breaches);
    expect(loaded.containers).toEqual(delta.containers);
    expect(loaded.movedObjects).toEqual(delta.movedObjects);
    expect(loaded.droppedItems).toEqual(delta.droppedItems);
    expect(loaded.corpses).toEqual(delta.corpses);
    expect(loaded.utilities).toEqual(delta.utilities);
    expect(loaded.population).toEqual(delta.population);
    expect(loaded.missionState).toEqual(delta.missionState);
    expect(loaded.idCounters).toEqual(counters);
  });

  it('restored IdFactory counters prevent post-load id collisions (V26)', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const pre = new IdFactory();
    const a = pre.next<number>('entity'); // 0
    const b = pre.next<number>('entity'); // 1
    const delta = captureSaveDelta({
      worldVersion: WORLD,
      partition: PARTITION,
      capturedAtTick: 1,
      idCounters: pre.snapshot(),
    });
    await writeSaveDelta(adapter, delta);
    const loaded = (await readSaveDelta(adapter, PARTITION, WORLD))!;

    const post = new IdFactory();
    post.restore(loaded.idCounters as IdCounterSnapshot);
    const c = post.next<number>('entity'); // must be 2, never reuse 0/1
    expect([a, b]).toEqual([0, 1]);
    expect(c).toBe(2);
    expect(c).not.toBe(a);
    expect(c).not.toBe(b);
  });
});

describe('schema migration (V23)', () => {
  it('migrates a v1 record forward on load, filling new categories as "unchanged"', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    // hand-write a first-build (v1) record: only structural modules existed.
    const v1 = {
      schemaVersion: 1,
      worldVersion: WORLD,
      district: PARTITION.district,
      sector: PARTITION.sector,
      capturedAtTick: 7,
      modules: [{ module: 1, cells: [{ cell: 0, strength: 10, breached: false }] }],
    };
    await adapter.put(PARTITION, saveDeltaKey(PARTITION), v1);

    const loaded = (await readSaveDelta(adapter, PARTITION, WORLD))!;
    expect(loaded.schemaVersion).toBe(CURRENT_SAVE_SCHEMA_VERSION);
    expect(loaded.modules).toEqual(v1.modules);
    expect(loaded.functional).toEqual([]);
    expect(loaded.fires).toEqual([]);
    expect(loaded.population).toBeNull();
    expect(loaded.idCounters).toBeNull();
  });

  it('rejects a future schema version rather than guessing (V23)', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const future = { schemaVersion: CURRENT_SAVE_SCHEMA_VERSION + 5, worldVersion: WORLD, district: 2, sector: 5, capturedAtTick: 1, modules: [] };
    await adapter.put(PARTITION, saveDeltaKey(PARTITION), future);
    await expect(readSaveDelta(adapter, PARTITION, WORLD)).rejects.toBeInstanceOf(SchemaError);
  });

  it('rejects a versionless / corrupt record', () => {
    expect(() => migrateSaveDelta({ worldVersion: WORLD })).toThrow(SchemaError);
    expect(() => migrateSaveDelta(null)).toThrow(SaveCompatError);
  });
});

describe('compatibility validation (V23)', () => {
  const base: SaveDelta = captureSaveDelta({ worldVersion: WORLD, assetVersion: ASSET, partition: PARTITION, capturedAtTick: 0 });

  it('rejects a world-version mismatch', () => {
    expect(() => validateSaveCompat(base, 'base-2.0.0')).toThrow(SaveCompatError);
  });

  it('rejects an asset-version mismatch', () => {
    expect(() => validateSaveCompat(base, WORLD, 'assets-9.9.9')).toThrow(SaveCompatError);
  });

  it('rejects when an asset version is required but the save lacks one', () => {
    const noAsset = captureSaveDelta({ worldVersion: WORLD, partition: PARTITION, capturedAtTick: 0 });
    expect(() => validateSaveCompat(noAsset, WORLD, ASSET)).toThrow(SaveCompatError);
  });

  it('accepts a matching world + asset version', () => {
    expect(() => validateSaveCompat(base, WORLD, ASSET)).not.toThrow();
  });
});
