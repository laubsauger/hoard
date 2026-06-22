// T38 — the M1 vertical-slice wiring on the GameRuntime: player movement intent, sound attraction
// (firing reroutes the SHARED flow field toward the gunshot), command-contract routing for structural
// modify + targeting, day/night derived from the clock, and the full save/load round-trip of the slice.

import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildCityBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { resolveDomain } from '@/config/registry';
import { combatConfig } from '@/config/domains/combat';
import { weatherConfig } from '@/config/domains/weather';
import type { CommandId, EntityId, ModuleId } from '@/game/core/contracts';

const TIER = 'desktop-high' as const;
const RADIUS = resolveDomain(combatConfig, TIER).gateZeroSpawnRadiusMeters;
const WEATHER = resolveDomain(weatherConfig, TIER);
const MOVEMENT_PROFILE = 'zombie-walk';

function makeRuntime() {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildCityBlock() });
}

function navCellOf(rt: GameRuntime, x: number, z: number): number {
  const c = rt.scene.navGrid.worldToCell(x, z);
  return rt.scene.navGrid.index(c.cx, c.cy);
}

describe('M1 slice: player movement (engine-validated intent, V1)', () => {
  it('ignores a zero intent and walks in open space', () => {
    const rt = makeRuntime();
    expect(rt.movePlayer(0, 0, 0.1)).toBe(false);
    const before = { ...rt.player() };
    expect(rt.movePlayer(0, -1, 0.1)).toBe(true);
    expect(rt.player().z).toBeLessThan(before.z);
  });

  it('refuses to tunnel through the dividing wall (stays walkable)', () => {
    const rt = makeRuntime();
    for (let i = 0; i < 400; i++) rt.movePlayer(-1, 0, 0.05); // shove west into room B's wall
    const p = rt.player();
    expect(rt.scene.isWalkableWorld(p.x, p.z)).toBe(true);
    expect(p.x).toBeGreaterThan(45); // never crossed into the dividing-wall column (world x ~44-46)
  });
});

describe('M1 slice: sound attraction reroutes the shared flow field (V14/V15)', () => {
  it('emits a gunshot stimulus the horde hears', () => {
    const rt = makeRuntime();
    const p = rt.player();
    rt.fire(1, 0, 'torsoUpper');
    const hits = rt.stimulus.query(p.x, p.z, rt.tick);
    expect(hits.some((h) => h.stimulus.kind === 'sound')).toBe(true);
  });

  it('retargets the whole horde to the gunshot, then expires back to the player', () => {
    const rt = makeRuntime();
    rt.spawnHorde(30, RADIUS);
    const fireSpot = { ...rt.player() };

    rt.fire(1, 0, 'torsoUpper'); // gunshot at the player's current position
    for (let i = 0; i < 20; i++) rt.movePlayer(1, 0, 0.1); // then walk away from the noise
    rt.update(0.3); // run ticks incl. the sound system -> lure latches onto the gunshot

    const lureCell = rt.flowTargetCell;
    expect(lureCell).toBe(navCellOf(rt, fireSpot.x, fireSpot.z));
    const here = rt.player();
    expect(lureCell).not.toBe(navCellOf(rt, here.x, here.z)); // chasing the SOUND, not the player

    // No more noise: after the disturbance lingers + the investigate window, the shared target falls
    // back to tracking the live player (gunfire registers a lingering disturbance, so this takes a while).
    for (let i = 0; i < 130; i++) rt.update(0.2);
    const after = rt.player();
    expect(rt.flowTargetCell).toBe(navCellOf(rt, after.x, after.z));
  });
});

describe('M1 slice: command-contract routing (V1)', () => {
  it('breaches the wall via modifyStructure and opens the sealed nav route locally (V5)', () => {
    const rt = makeRuntime();
    const navGrid = rt.scene.navGrid;
    const target = rt.scene.navIndex(rt.scene.playerCell);
    const probe = rt.scene.navIndex(rt.scene.spawnCenterCell);
    expect(rt.flowCache.get(navGrid, target, MOVEMENT_PROFILE).isReachable(probe)).toBe(false);

    const res = rt.dispatch({
      kind: 'modifyStructure',
      id: 1 as CommandId,
      module: rt.scene.moduleId as ModuleId,
      cell: rt.defaultBreachCell(),
      op: 'breach',
    });
    expect(res.ok).toBe(true);
    expect(rt.flowCache.get(navGrid, target, MOVEMENT_PROFILE).isReachable(probe)).toBe(true);
  });

  it('rejects an unknown module and an unsupported command kind with a reason', () => {
    const rt = makeRuntime();
    const bad = rt.dispatch({ kind: 'modifyStructure', id: 2 as CommandId, module: 999 as ModuleId, cell: 0, op: 'breach' });
    expect(bad.ok).toBe(false);
    const unsupported = rt.dispatch({ kind: 'craft', id: 3 as CommandId, entity: rt.playerEntity, recipe: 'x' });
    expect(unsupported.ok).toBe(false);
  });

  it('routes selectTarget through dispatch', () => {
    const rt = makeRuntime();
    const c = rt.scene.cellCenter({ cx: rt.scene.playerCell.cx - 1, cy: rt.scene.playerCell.cy });
    const e = rt.spawnZombie({ x: c.x, y: 0, z: c.z });
    const r = rt.dispatch({ kind: 'selectTarget', id: 4 as CommandId, entity: rt.playerEntity, target: e as EntityId });
    expect(r.ok).toBe(true);
  });
});

describe('M1 slice: day/night from the clock (V12)', () => {
  it('starts at the configured time and advances deterministically with the clock', () => {
    const rt = makeRuntime();
    expect(rt.timeOfDay()).toBeCloseTo(WEATHER.startTimeOfDay, 5);
    const start = rt.timeOfDay();
    for (let i = 0; i < 40; i++) rt.update(0.2);
    const expected = (WEATHER.startTimeOfDay + (rt.tick * rt.clock.tickSeconds) / WEATHER.dayLengthSeconds) % 1;
    expect(rt.timeOfDay()).toBeCloseTo(expected, 6);
    expect(rt.timeOfDay()).not.toBeCloseTo(start, 6);
  });
});

describe('M1 slice: save/load round-trip (V9/V23/V26)', () => {
  it('restores breach, population, player avatar and weather into a fresh runtime', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const rtA = new GameRuntime({ tier: TIER, adapter, scene: buildCityBlock() });
    rtA.spawnHorde(12, RADIUS);
    rtA.breachWall();
    for (let i = 0; i < 10; i++) rtA.movePlayer(1, 0, 0.1);
    rtA.aim(0, 1);
    rtA.setWeather('fog');
    for (let i = 0; i < 5; i++) rtA.update(0.1);

    const savedCount = rtA.aliveCount;
    const savedPlayer = { ...rtA.player() };
    await rtA.save();

    const rtB = new GameRuntime({ tier: TIER, adapter, scene: buildCityBlock() });
    await rtB.loadFrom();

    expect(rtB.aliveCount).toBe(savedCount);
    expect(rtB.weather).toBe('fog');
    expect(rtB.player().x).toBeCloseTo(savedPlayer.x, 4);
    expect(rtB.player().z).toBeCloseTo(savedPlayer.z, 4);
    expect(rtB.scene.wall.isBreached(rtB.scene.wall.packCell(0, 0, 1))).toBe(true);
  });
});
