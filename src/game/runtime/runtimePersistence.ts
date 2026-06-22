// T41 / T33 / T40 — RuntimePersistence: the save/load orchestration lifted out of GameRuntime so the
// runtime stays an orchestrator, not a god-object. Owns the V9/V23/V26 persistence flow — structural
// SaveDelta + runtime record (id counters, live population, player, weather, M2 objective + district) —
// reading/writing authoritative state through a narrow port so GameRuntime remains the single authority.

import type { EntityId } from '@/game/core';
import type { SimulationZombies, ZombieSlot } from '@/game/simulation';
import type { IdFactory } from '@/game/core';
import type { TestBlock, Vec3 } from '@/game/scene';
import type { ObjectiveSave } from '@/game/objective';
import type { SectorPopulationSave } from '@/game/world';
import {
  captureSaveDelta,
  readSaveDelta,
  writeSaveDelta,
  SaveCompatError,
  type ModuleDelta,
  type PartitionKey,
  type PersistenceAdapter,
} from '@/game/persistence';
import {
  RUNTIME_SAVE_KEY,
  RUNTIME_SAVE_SCHEMA_VERSION,
  migrateRuntimeSave,
  type PopulationEntry,
  type RuntimeSave,
} from './saveRecord';

/** Save/restore of the medium-term objective (M2). Structural subset of ObjectiveSystem. */
export interface ObjectivePort {
  save(): ObjectiveSave;
  restore(s: ObjectiveSave): void;
}

/** Save/restore of the per-sector abstract district population (M2). Structural subset of DistrictModel. */
export interface DistrictPort {
  save(): readonly SectorPopulationSave[];
  restore(s: readonly SectorPopulationSave[]): void;
}

/**
 * The authoritative state RuntimePersistence reads/writes. GameRuntime supplies this via closures so its
 * own fields stay private — persistence never reaches into the runtime's internals directly (V1).
 */
export interface RuntimePersistencePort {
  readonly adapter: PersistenceAdapter;
  readonly partition: PartitionKey;
  readonly scene: TestBlock;
  readonly zombies: SimulationZombies;
  readonly ids: IdFactory;
  readonly objective: ObjectivePort;
  readonly district: DistrictPort | null;
  entityOf(slot: ZombieSlot): EntityId;
  placeZombie(entity: EntityId, e: PopulationEntry): void;
  openBreachedNav(structuralCell: number): void;
  /** Authoritative tick (without the load-time offset) — the live clock tick. */
  getClockTick(): number;
  getTickOffset(): number;
  setTickOffset(tick: number): void;
  getPlayer(): { pos: Readonly<Vec3>; heading: number };
  setPlayer(pos: Vec3, heading: number): void;
  getWeather(): string;
  setWeather(profile: string): void;
}

/** Serialize the live SoA population to stable-id records — the one piece independent of runtime wiring. */
export function collectPopulation(
  zombies: SimulationZombies,
  entityOf: (slot: ZombieSlot) => EntityId,
): PopulationEntry[] {
  const population: PopulationEntry[] = [];
  const pos: [number, number, number] = [0, 0, 0];
  zombies.forEachAlive((slot) => {
    zombies.getPosition(slot, pos);
    population.push({
      entity: entityOf(slot) as number,
      archetype: zombies.getArchetype(slot),
      x: pos[0],
      y: pos[1],
      z: pos[2],
      heading: zombies.getHeading(slot),
      state: zombies.getState(slot),
      health: zombies.getHealth(slot),
      anatomyFlags: zombies.getAnatomyFlags(slot),
      navGroup: zombies.getNavGroup(slot),
    });
  });
  return population;
}

export class RuntimePersistence {
  constructor(private readonly p: RuntimePersistencePort) {}

  /** Persist the compact delta: structural breaches (lane-S SaveDelta) + id counters + population (V9). */
  async save(): Promise<void> {
    const p = this.p;
    const moduleDeltas: ModuleDelta[] = [
      { module: p.scene.moduleId as number, cells: p.scene.wall.modificationDelta() },
    ];
    const delta = captureSaveDelta({
      worldVersion: p.scene.worldVersion,
      partition: p.partition,
      capturedAtTick: p.getClockTick(),
      modules: moduleDeltas,
    });
    await writeSaveDelta(p.adapter, delta);

    const player = p.getPlayer();
    const record: RuntimeSave = {
      schemaVersion: RUNTIME_SAVE_SCHEMA_VERSION,
      worldVersion: p.scene.worldVersion,
      capturedAtTick: p.getClockTick() + p.getTickOffset(),
      idCounters: p.ids.snapshot(),
      population: collectPopulation(p.zombies, (slot) => p.entityOf(slot)),
      player: { x: player.pos.x, y: player.pos.y, z: player.pos.z, heading: player.heading },
      weather: p.getWeather(),
      // M2 (schema v2): the medium-term objective + per-sector abstract district population (V9).
      objective: p.objective.save(),
      ...(p.district ? { district: p.district.save() } : {}),
    };
    await p.adapter.put(p.partition, RUNTIME_SAVE_KEY, record);
  }

  /**
   * Reconstruct authoritative state into a FRESH runtime from a saved delta (V9): re-apply the structural
   * breach delta + re-open its LOCAL nav, restore IdFactory counters (so post-load ids never collide —
   * V26), and re-create the live population at their stable EntityIds. Migrates v1 (M1) saves forward.
   */
  async loadFrom(): Promise<void> {
    const p = this.p;
    if (p.zombies.count > 0) throw new Error('loadFrom must run on a fresh runtime');

    const delta = await readSaveDelta(p.adapter, p.partition, p.scene.worldVersion); // validates V23
    if (delta) {
      for (const m of delta.modules) {
        if (m.module === (p.scene.moduleId as number)) {
          p.scene.wall.applyDeltaSnapshot(m.cells);
        }
      }
      // applyDeltaSnapshot does not run hooks; re-open LOCAL nav for every breached cell so the route
      // is reconstructed exactly (same breach state feeds nav — V18).
      for (let z = 0; z < p.scene.wall.sizeZ; z++) {
        const cell = p.scene.wall.packCell(0, 0, z);
        if (p.scene.wall.isBreached(cell)) p.openBreachedNav(cell);
      }
    }

    const stored = await p.adapter.get<RuntimeSave>(p.partition, RUNTIME_SAVE_KEY);
    if (stored) {
      if (stored.worldVersion !== p.scene.worldVersion) {
        throw new SaveCompatError(`runtime save world '${stored.worldVersion}' != '${p.scene.worldVersion}'`);
      }
      // Migrate forward (v1 M1 saves -> v2 M2): rejects future versions, defaults the new fields (V23).
      const record = migrateRuntimeSave(stored);
      // Restore counters first; population is recreated at saved ids (no minting), so the next mint
      // is guaranteed beyond every restored id.
      p.ids.restore(record.idCounters);
      for (const e of record.population) {
        p.placeZombie(e.entity as EntityId, e);
      }
      // Restore the player avatar + weather + day-time offset so the reloaded slice resumes in place.
      if (record.player) {
        p.setPlayer({ x: record.player.x, y: record.player.y, z: record.player.z }, record.player.heading);
      }
      if (record.weather) p.setWeather(record.weather);
      p.setTickOffset(record.capturedAtTick);
      // M2 subsystems: restore objective + district population (absent in migrated v1 saves -> defaults).
      if (record.objective) p.objective.restore(record.objective);
      if (record.district && p.district) p.district.restore(record.district);
    }
  }
}
