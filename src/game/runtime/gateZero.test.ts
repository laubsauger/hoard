// T41 — GATE-0 integrating proof. Stitches the Wave-1 lanes via frozen contracts into one runnable
// vertical slice and asserts the architecture holds: crowd + destruction + nav + state-boundary.
// Cites V1, V2, V5, V9, V11, V13, V15, V16, V23, V26, V27.

import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { createPlayerViewStore, createMapViewStore } from '@/stores';
import { resolveDomain } from '@/config/registry';
import { combatConfig } from '@/config/domains/combat';

const TIER = 'desktop-high' as const;
const COMBAT = resolveDomain(combatConfig, TIER);
const COUNT = COMBAT.gateZeroZombieCount;
const SPAWN_R = COMBAT.gateZeroSpawnRadiusMeters;
const MOVEMENT_PROFILE = 'zombie-walk';
const TICK_DT = 1 / 30;

function makeRuntime() {
  const adapter = new InMemoryPersistenceAdapter();
  const playerStore = createPlayerViewStore();
  const mapStore = createMapViewStore();
  const rt = new GameRuntime({ tier: TIER, adapter, scene: buildTestBlock(), playerStore, mapStore });
  return { rt, adapter, playerStore, mapStore };
}

function hordeMetrics(rt: GameRuntime) {
  const pos: [number, number, number] = [0, 0, 0];
  const p = rt.player();
  let sum = 0;
  let n = 0;
  let min = Number.POSITIVE_INFINITY;
  rt.zombies.forEachAlive((slot) => {
    rt.zombies.getPosition(slot, pos);
    const d = Math.hypot(pos[0] - p.x, pos[2] - p.z);
    sum += d;
    n += 1;
    if (d < min) min = d;
  });
  return { mean: sum / n, min, n };
}

describe('GATE-0: crowd scale + stepping (V2/V10/V12)', () => {
  it('spawns >= 500 zombies and steps many fixed ticks without error or spurious death', () => {
    const { rt } = makeRuntime();
    rt.spawnHorde(COUNT, SPAWN_R);
    expect(COUNT).toBeGreaterThanOrEqual(500);
    expect(rt.aliveCount).toBe(COUNT);

    rt.breachWall(); // open the route so the horde can stream toward the player

    let totalTicks = 0;
    for (let i = 0; i < 200; i++) totalTicks += rt.update(TICK_DT);

    expect(totalTicks).toBeGreaterThan(150);
    // V16: navigation overlap NEVER applies damage — a pure movement run kills no one.
    expect(rt.aliveCount).toBe(COUNT);
  });
});

describe('GATE-0: shared flow-field steering (V15/V19)', () => {
  it('moves the horde toward the player target along one shared field', () => {
    const { rt } = makeRuntime();
    rt.spawnHorde(COUNT, SPAWN_R);
    rt.breachWall();

    const before = hordeMetrics(rt);
    for (let i = 0; i < 300; i++) rt.update(TICK_DT);
    const after = hordeMetrics(rt);

    expect(after.n).toBe(COUNT);
    // The ENGAGED front streams toward the player through the breach — the "the horde comes after you" core
    // promise. The front-runner closes meaningfully (the bulk is bottlenecked behind the 1-cell breach).
    expect(after.min).toBeLessThan(before.min - 1);
    // T137: the disengaged back (out of perception range) now WANDERS rather than standing frozen, so the global
    // mean no longer monotonically closes — but the horde must not FLEE either; idle wander stays bounded.
    expect(after.mean).toBeLessThan(before.mean + 2);
  });
});

describe('GATE-0: firearm anatomical hit path (V16/V17)', () => {
  it('a head shot kills the targeted body and emits the right world + visual events', () => {
    const { rt } = makeRuntime();
    const p = rt.player();
    const entity = rt.spawnZombie({ x: p.x - 5, y: 0, z: p.z });

    const res = rt.fire(-1, 0, 'head');
    expect(res.hit).toBe(true);
    expect(res.targetEntity).toBe(entity);
    expect(res.candidateCount).toBeGreaterThan(0); // V16: candidates gathered from swept cells
    expect(res.killed).toBe(true);
    expect(rt.isAliveEntity(entity)).toBe(false); // authoritative death + lifecycle teardown

    const { world, visual } = rt.pollEvents();
    expect(world.some((e) => e.kind === 'hitResolved' && e.target === entity)).toBe(true);
    expect(world.some((e) => e.kind === 'entityDied' && e.entity === entity)).toBe(true);
    expect(visual.some((e) => e.kind === 'hitReaction')).toBe(true);
    expect(visual.some((e) => e.kind === 'bloodSpray')).toBe(true);
  });

  it('a torso shot wounds but does not kill (head-kill rule is region-specific, V17)', () => {
    const { rt } = makeRuntime();
    const p = rt.player();
    const entity = rt.spawnZombie({ x: p.x - 5, y: 0, z: p.z });

    const res = rt.fire(-1, 0, 'torsoUpper');
    expect(res.hit).toBe(true);
    expect(res.killed).toBe(false);
    expect(rt.isAliveEntity(entity)).toBe(true);
    const slot = rt.slotOf(entity)!;
    expect(rt.zombies.getHealth(slot)).toBeLessThan(COMBAT.zombieBaseHealth);
    expect(rt.zombies.getHealth(slot)).toBeGreaterThan(0);
  });

  it('a limb shot can sever (anatomyFlags bit set) without killing (V17)', () => {
    const { rt } = makeRuntime();
    const p = rt.player();
    const entity = rt.spawnZombie({ x: p.x - 5, y: 0, z: p.z });

    const res = rt.fire(-1, 0, 'legLeft');
    expect(res.hit).toBe(true);
    expect(res.severed).toBe(true);
    expect(res.killed).toBe(false);
    expect(rt.isAliveEntity(entity)).toBe(true); // severed limb is not fatal
    const { world } = rt.pollEvents();
    expect(world.some((e) => e.kind === 'hitResolved' && e.severed === true)).toBe(true);
  });
});

describe('GATE-0: breach opens a nav route, locally (V5/V18)', () => {
  it('a previously-sealed room becomes reachable after breaching the wall, dirtying only local tiles', () => {
    const { rt } = makeRuntime();
    const navGrid = rt.scene.navGrid;
    const target = rt.scene.navIndex(rt.scene.playerCell);
    const probe = rt.scene.navIndex(rt.scene.spawnCenterCell); // a cell deep in the sealed room A

    const fieldBefore = rt.flowCache.get(navGrid, target, MOVEMENT_PROFILE);
    expect(fieldBefore.isReachable(probe)).toBe(false); // room A is sealed off

    navGrid.consumeDirtyTiles(); // clear authoring dirties to isolate the breach's contribution
    const revBefore = rt.navRevision;
    const totalTiles = navGrid.tilesX * navGrid.tilesY;

    rt.breachWall();

    expect(rt.navRevision).toBeGreaterThan(revBefore); // V5: nav revision bumped
    const dirty = navGrid.dirtyTileList();
    expect(dirty.length).toBeGreaterThan(0);
    expect(dirty.length).toBeLessThan(totalTiles); // V5: only LOCAL tiles dirty, never a full rebuild

    const fieldAfter = rt.flowCache.get(navGrid, target, MOVEMENT_PROFILE);
    expect(fieldAfter).not.toBe(fieldBefore); // cache invalidated by the bumped navRevision
    expect(fieldAfter.isReachable(probe)).toBe(true); // the route is now open (central promise)
  });
});

describe('GATE-0: save -> evict -> reload (V9/V23/V26)', () => {
  it('restores breach state, population and id counters into a fresh runtime', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const rtA = new GameRuntime({
      tier: TIER,
      adapter,
      scene: buildTestBlock(),
      playerStore: createPlayerViewStore(),
      mapStore: createMapViewStore(),
    });
    rtA.spawnHorde(COUNT, SPAWN_R);
    rtA.breachWall();
    for (let i = 0; i < 30; i++) rtA.update(TICK_DT);

    const savedCount = rtA.aliveCount;
    const savedEntityCounter = rtA.ids.peek('entity');
    await rtA.save();

    // evict: rtA is discarded; rtB is a brand-new runtime over a freshly rebuilt BASE block (V9).
    const rtB = new GameRuntime({
      tier: TIER,
      adapter,
      scene: buildTestBlock(),
      playerStore: createPlayerViewStore(),
      mapStore: createMapViewStore(),
    });
    await rtB.loadFrom();

    // population restored
    expect(rtB.aliveCount).toBe(savedCount);

    // breach restored in the structural delta
    const breachedCell = rtB.scene.wall.packCell(0, 0, 1);
    expect(rtB.scene.wall.isBreached(breachedCell)).toBe(true);

    // nav route reconstructed from the same breach state (V18)
    const target = rtB.scene.navIndex(rtB.scene.playerCell);
    const probe = rtB.scene.navIndex(rtB.scene.spawnCenterCell);
    expect(rtB.flowCache.get(rtB.scene.navGrid, target, MOVEMENT_PROFILE).isReachable(probe)).toBe(true);

    // V26: id counters restored so a post-load mint cannot collide with any restored id
    expect(rtB.ids.peek('entity')).toBe(savedEntityCounter);
    const c = rtB.scene.cellCenter({ cx: rtB.scene.playerCell.cx, cy: rtB.scene.playerCell.cy + 2 });
    const newEntity = rtB.spawnZombie({ x: c.x, y: 0, z: c.z });
    expect(newEntity as number).toBeGreaterThanOrEqual(savedEntityCounter);
  });

  it('rejects a save written for a different world version (V23)', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const rtA = new GameRuntime({ tier: TIER, adapter, scene: buildTestBlock(), playerStore: createPlayerViewStore(), mapStore: createMapViewStore() });
    rtA.spawnHorde(8, SPAWN_R);
    await rtA.save();

    // a runtime whose scene reports a different world version must refuse the delta.
    const foreignScene = { ...buildTestBlock(), worldVersion: 'some-other-world' };
    const rtB = new GameRuntime({ tier: TIER, adapter, scene: foreignScene, playerStore: createPlayerViewStore(), mapStore: createMapViewStore() });
    await expect(rtB.loadFrom()).rejects.toThrow();
  });
});

describe('GATE-0: React/Zustand boundary (V1/V11)', () => {
  it('the HUD stores update ONLY from published snapshots — never per-frame world arrays', () => {
    const { rt, playerStore, mapStore } = makeRuntime();

    // before any publish the stores are empty (engine has not pushed a snapshot yet).
    expect(playerStore.getState().snapshot).toBeNull();
    expect(mapStore.getState().horde).toBeNull();

    rt.spawnHorde(COUNT, SPAWN_R);
    for (let i = 0; i < 10; i++) rt.update(0.1); // ~1s — crosses the throttle intervals

    const snap = playerStore.getState().snapshot;
    expect(snap).not.toBeNull();
    expect(snap!.entity).toBe(rt.playerEntity);
    // V1: the player snapshot is a small object of PRIMITIVES — no zombie array, no SoA buffer.
    for (const v of Object.values(snap!)) expect(typeof v).toBe('number');

    const horde = mapStore.getState().horde;
    expect(horde).not.toBeNull();
    for (const v of Object.values(horde!)) expect(typeof v).toBe('number');
    // coarse counts, NOT entities (V1): visible count can never exceed the live population.
    expect(horde!.visibleCount + horde!.abstractCount).toBeLessThanOrEqual(COUNT);
    expect(horde!.activeCount).toBeGreaterThanOrEqual(0);

    // structural: the only mutators on the player store are snapshot setters — no array sink exists.
    const keys = Object.keys(playerStore.getState());
    expect(keys).toEqual(expect.arrayContaining(['snapshot', 'applySnapshot', 'clear']));
    // and the store never references the authoritative SoA backing buffer.
    for (const v of Object.values(playerStore.getState())) {
      expect(v).not.toBe(rt.zombies.buffer);
    }
  });
});
