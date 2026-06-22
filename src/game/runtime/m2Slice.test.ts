// T40 — M2 vertical-slice wiring on the GameRuntime: district streaming (abstract sector pops promote to
// live as the player traverses, V13), the medium-term objective driven by confirmAction commands (V1),
// the decisive horde event branching on the player's structural modifications (§G), and the district-scale
// save -> reload -> migrate round-trip (V9/V23/V26).

import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { RUNTIME_SAVE_KEY, type RuntimeSave } from './saveRecord';
import { buildCityDistrict } from '@/game/scene';
import { InMemoryPersistenceAdapter, type PartitionKey } from '@/game/persistence';
import { resolveDomain } from '@/config/registry';
import { combatConfig } from '@/config/domains/combat';
import type { CommandId, EntityId, ModuleId } from '@/game/core/contracts';

const TIER = 'desktop-high' as const;
const COMBAT = resolveDomain(combatConfig, TIER);
const PARTITION: PartitionKey = { district: 0, sector: 0 };

let cmdSeq = 1;
const nextCmd = (): CommandId => cmdSeq++ as unknown as CommandId;

function makeRuntime(adapter = new InMemoryPersistenceAdapter()) {
  const district = buildCityDistrict(TIER);
  const rt = new GameRuntime({ tier: TIER, adapter, scene: district.block, sectors: district.sectors });
  return rt;
}

function step(rt: GameRuntime, seconds: number, slices = 20) {
  for (let i = 0; i < slices; i++) rt.update(seconds / slices);
}

function collect(rt: GameRuntime, action: string) {
  return rt.dispatch({ kind: 'confirmAction', id: nextCmd(), entity: rt.playerEntity as EntityId, action });
}

describe('M2 slice: district streaming promotes abstract population near the player (V13)', () => {
  it('streams sectors in and promotes a capped abstract slice to live as the player traverses', () => {
    const rt = makeRuntime();
    rt.spawnHorde(COMBAT.gateZeroZombieCount, COMBAT.gateZeroSpawnRadiusMeters);
    expect(rt.district).not.toBeNull();
    const initialAlive = rt.aliveCount;
    const abstractStart = rt.district!.abstractTotal();

    step(rt, 1); // first district step activates sectors within range of the player's start

    expect(rt.district!.liveTotal()).toBeGreaterThan(0); // some abstract pop promoted to live
    expect(rt.aliveCount).toBeGreaterThan(initialAlive); // the live SoA grew by the promotions
    expect(rt.district!.abstractTotal()).toBeLessThan(abstractStart); // conserved: abstract -> live
  });
});

describe('M2 slice: medium-term objective via confirmAction commands (V1)', () => {
  it('drives the objective through its phases and arms the decisive event on evacuation', () => {
    const rt = makeRuntime();
    expect(rt.objective.currentPhase).toBe('locateParts');

    // Advancing before the precondition is met fails with an explicit reason.
    const tooEarly = collect(rt, 'objective.advance');
    expect(tooEarly.ok).toBe(false);

    for (let i = 0; i < COMBAT.gateZeroZombieCount && rt.objective.snapshot(0).partsFound < rt.objective.snapshot(0).partsRequired; i++) {
      collect(rt, 'objective.collectPart');
    }
    expect(collect(rt, 'objective.advance').ok).toBe(true);
    expect(rt.objective.currentPhase).toBe('repairRadio');

    expect(collect(rt, 'objective.repair').ok).toBe(true);
    expect(collect(rt, 'objective.advance').ok).toBe(true);
    expect(rt.objective.currentPhase).toBe('callEvacuation');

    expect(rt.hordeEvent.currentPhase).toBe('idle');
    expect(collect(rt, 'objective.advance').ok).toBe(true);
    expect(rt.objective.currentPhase).toBe('evacuating');
    expect(rt.hordeEvent.currentPhase).toBe('building'); // arming evacuation triggered the climax
  });

  it('rejects an unknown action cleanly (V1 — fails with a reason, no crash)', () => {
    const rt = makeRuntime();
    const r = collect(rt, 'objective.nope');
    expect(r.ok).toBe(false);
  });
});

describe('M2 slice: decisive horde event shaped by the player (§G central promise)', () => {
  function modifyAllCells(rt: GameRuntime, op: 'breach' | 'reinforce') {
    for (let z = 0; z < rt.scene.wall.sizeZ; z++) {
      rt.dispatch({
        kind: 'modifyStructure',
        id: nextCmd(),
        module: rt.scene.moduleId as ModuleId,
        cell: rt.scene.wall.packCell(0, 0, z),
        op,
      });
    }
  }

  it('the SAME event resolves differently for breached-open vs reinforced routes', () => {
    const breached = makeRuntime();
    breached.spawnHorde(COMBAT.gateZeroZombieCount, COMBAT.gateZeroSpawnRadiusMeters);
    modifyAllCells(breached, 'breach');
    const breachedResult = breached.evaluateEventNow();

    const reinforced = makeRuntime();
    reinforced.spawnHorde(COMBAT.gateZeroZombieCount, COMBAT.gateZeroSpawnRadiusMeters);
    modifyAllCells(reinforced, 'reinforce');
    const reinforcedResult = reinforced.evaluateEventNow();

    expect(breachedResult.outcome).toBe('overrun');
    expect(reinforcedResult.outcome).toBe('contained');
    expect(breachedResult.totalPressure).toBeGreaterThan(reinforcedResult.totalPressure);
    expect(breachedResult.openRouteCount).toBe(breached.scene.wall.sizeZ);
    expect(reinforcedResult.reinforcedRouteCount).toBe(reinforced.scene.wall.sizeZ);
  });

  it('igniting an open route reroutes the mass (lower pressure than the unburnt breach)', () => {
    const open = makeRuntime();
    open.spawnHorde(COMBAT.gateZeroZombieCount, COMBAT.gateZeroSpawnRadiusMeters);
    modifyAllCells(open, 'breach');
    const before = open.evaluateEventNow().totalPressure;
    for (let z = 0; z < open.scene.wall.sizeZ; z++) open.igniteRoute(open.scene.wall.packCell(0, 0, z));
    const after = open.evaluateEventNow().totalPressure;
    expect(after).toBeLessThan(before);
  });
});

describe('M2 slice: district-scale save -> reload -> migrate (V9/V23/V26)', () => {
  it('round-trips structural mods + objective + district population + live population', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const rt = makeRuntime(adapter);
    rt.spawnHorde(COMBAT.gateZeroZombieCount, COMBAT.gateZeroSpawnRadiusMeters);
    step(rt, 1); // stream some sectors in

    rt.breachWall();
    collect(rt, 'objective.collectPart');
    const breachedMid = rt.scene.wall.packCell(0, 0, 1);
    const abstractBefore = rt.district!.abstractTotal();
    const liveBefore = rt.aliveCount;
    const partsBefore = rt.objective.snapshot(0).partsFound;
    await rt.save();

    const reloaded = makeRuntime(adapter);
    await reloaded.loadFrom();
    expect(reloaded.scene.wall.isBreached(breachedMid)).toBe(true); // structural mod restored
    expect(reloaded.objective.snapshot(0).partsFound).toBe(partsBefore); // objective restored
    expect(reloaded.district!.abstractTotal()).toBe(abstractBefore); // district pop restored
    expect(reloaded.aliveCount).toBe(liveBefore); // live population restored at stable ids
  });

  it('migrates a v1 (M1) runtime save forward — objective defaults, no crash (V23)', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const seed = makeRuntime(adapter);
    seed.spawnHorde(COMBAT.gateZeroZombieCount, COMBAT.gateZeroSpawnRadiusMeters);
    await seed.save(); // writes a v2 record + the structural delta

    // Downgrade the stored runtime record to a v1 shape (no objective/district), as an old build wrote it.
    const stored = (await adapter.get<RuntimeSave>(PARTITION, RUNTIME_SAVE_KEY))!;
    const v1: Record<string, unknown> = { ...stored, schemaVersion: 1 };
    delete v1.objective;
    delete v1.district;
    await adapter.put(PARTITION, RUNTIME_SAVE_KEY, v1);

    const reloaded = makeRuntime(adapter);
    await reloaded.loadFrom(); // must migrate, not throw
    expect(reloaded.objective.currentPhase).toBe('locateParts'); // defaulted on migrate
    expect(reloaded.aliveCount).toBe(COMBAT.gateZeroZombieCount); // population still restored
  });
});
