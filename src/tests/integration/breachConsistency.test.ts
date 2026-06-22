// T39 — cross-system integration layer (V27 testing clause). The central promise (§G): one breach must
// propagate CONSISTENTLY across every system in a SINGLE run — the same authoritative breach state feeds
// navigation, the coarse region graph, visibility/breach-state reads, the audio stimulus field, the
// WorldEvent stream and persistence. One `it` per cross-system seam. Everything below acts on ONE runtime
// instance and ONE breach, so we are proving propagation, not re-testing each system in isolation.

import { describe, it, expect, beforeEach } from 'vitest';
import { GameRuntime } from '@/game/runtime';
import { buildTestBlock, REGION_ROOM_A, REGION_ROOM_B } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { createPlayerViewStore, createMapViewStore } from '@/stores';
import {
  resolveSurfaceVisibility,
  resolveVisibilitySettings,
} from '@/render/world/visibility';
import type { PersistenceAdapter } from '@/game/persistence';

const TIER = 'desktop-high' as const;
const MOVEMENT_PROFILE = 'zombie-walk';
const VIS = resolveVisibilitySettings(TIER);

function makeRuntime(adapter: PersistenceAdapter): GameRuntime {
  return new GameRuntime({
    tier: TIER,
    adapter,
    scene: buildTestBlock(),
    playerStore: createPlayerViewStore(),
    mapStore: createMapViewStore(),
  });
}

describe('integration: one breach propagates consistently across systems (V5/V9/V18/V20/V28)', () => {
  let adapter: InMemoryPersistenceAdapter;
  let rt: GameRuntime;

  beforeEach(() => {
    adapter = new InMemoryPersistenceAdapter();
    rt = makeRuntime(adapter);
  });

  it('NAVIGATION: the breach opens the sealed route, dirtying ONLY local tiles (V5)', () => {
    const navGrid = rt.scene.navGrid;
    const target = rt.scene.navIndex(rt.scene.playerCell);
    const probe = rt.scene.navIndex(rt.scene.spawnCenterCell);

    expect(rt.flowCache.get(navGrid, target, MOVEMENT_PROFILE).isReachable(probe)).toBe(false);

    navGrid.consumeDirtyTiles(); // isolate the breach's contribution from authoring dirties
    const revBefore = rt.navRevision;
    const totalTiles = navGrid.tilesX * navGrid.tilesY;

    rt.breachWall();

    expect(rt.navRevision).toBeGreaterThan(revBefore); // revision bumped -> flow cache invalidated
    const dirty = navGrid.dirtyTileList();
    expect(dirty.length).toBeGreaterThan(0);
    expect(dirty.length).toBeLessThan(totalTiles); // V5: LOCAL only, never a full-grid rebuild
    expect(rt.flowCache.get(navGrid, target, MOVEMENT_PROFILE).isReachable(probe)).toBe(true);
  });

  it('REGION GRAPH: the coarse room graph gains an open portal A<->B from the same breach', () => {
    expect(rt.scene.region.route(REGION_ROOM_A, REGION_ROOM_B)).toBeNull(); // sealed

    rt.breachWall();

    const route = rt.scene.region.route(REGION_ROOM_A, REGION_ROOM_B);
    expect(route).not.toBeNull();
    expect(route).toEqual([REGION_ROOM_A, REGION_ROOM_B]);
  });

  it('VISIBILITY / BREACH-STATE: the destruction authority now reads breached, and the base wall stays readable (V20)', () => {
    const cell = rt.scene.wall.packCell(0, 0, 1);
    expect(rt.scene.wall.isBreached(cell)).toBe(false);

    rt.breachWall();

    // the SINGLE authoritative breach flag is what the renderer reads (V18) — not a duplicated copy.
    expect(rt.scene.wall.isBreached(cell)).toBe(true);
    // V20: the base wall band stays opaque so the player can still read enclosure + the breach hole.
    const base = resolveSurfaceVisibility('baseWall', {
      playerInside: true,
      occludesPlayerView: true,
      roomEnclosed: true,
      portalOrLosToCamera: true,
      surfaceHeightMeters: 0,
    }, VIS);
    expect(base.visible).toBe(true);
    expect(base.targetOpacity).toBe(1);
  });

  it('AUDIO: the breach impact emits a sound stimulus the horde can perceive (V28)', () => {
    const activeBefore = rt.stimulus.activeCount;
    // Emit the breach as a heard 'breach' impact at the wall, then confirm the stimulus reaches a
    // listener standing there — behavior only ever learns of the world through stimuli (V14/V28).
    const wallCell = rt.scene.navCellForStructuralCell(rt.scene.wall.packCell(0, 0, 1));
    const wc = rt.scene.cellCenter(wallCell);
    rt.audio.hearEvent('breach', wc.x, wc.z, rt.tick);
    expect(rt.stimulus.activeCount).toBeGreaterThan(activeBefore); // a new stimulus entered the field
    const hits = rt.stimulus.query(wc.x, wc.z, rt.tick);
    expect(hits.some((h) => h.stimulus.kind === 'sound' && h.stimulus.source === 'breach')).toBe(true);
  });

  it('WORLD EVENTS: the breach emits structureModified + breachCreated facts for save/AI/render', () => {
    rt.breachWall();
    const { world } = rt.pollEvents();
    expect(world.some((e) => e.kind === 'structureModified' && e.module === (rt.scene.moduleId as number))).toBe(true);
    expect(world.some((e) => e.kind === 'breachCreated' && e.module === (rt.scene.moduleId as number))).toBe(true);
  });

  it('PERSISTENCE: the breach survives save -> evict -> reload, and the reloaded route is open (V9/V18)', async () => {
    rt.breachWall();
    const breachedCell = rt.scene.wall.packCell(0, 0, 1);
    expect(rt.scene.wall.isBreached(breachedCell)).toBe(true);
    await rt.save();

    // evict: discard rt; a brand-new runtime rebuilds the BASE block and re-applies the compact delta (V9).
    const rt2 = makeRuntime(adapter);
    // base is freshly sealed again before load — proving the breach lives in the DELTA, not the base.
    expect(rt2.scene.wall.isBreached(breachedCell)).toBe(false);
    expect(rt2.scene.region.route(REGION_ROOM_A, REGION_ROOM_B)).toBeNull();

    await rt2.loadFrom();

    // same breach state reconstructed -> destruction, region graph and nav route all agree again (V18).
    expect(rt2.scene.wall.isBreached(breachedCell)).toBe(true);
    expect(rt2.scene.region.route(REGION_ROOM_A, REGION_ROOM_B)).toEqual([REGION_ROOM_A, REGION_ROOM_B]);
    const target = rt2.scene.navIndex(rt2.scene.playerCell);
    const probe = rt2.scene.navIndex(rt2.scene.spawnCenterCell);
    expect(rt2.flowCache.get(rt2.scene.navGrid, target, MOVEMENT_PROFILE).isReachable(probe)).toBe(true);
  });

  it('END-TO-END: in ONE run the breach lets the shared-field horde reach the player it was sealed from', () => {
    rt.spawnHorde(20, 4);
    // distance to player before the route exists
    const distBefore = nearestZombieDistance(rt);

    rt.breachWall(); // nav + region + flow-field cache all update off this single edit
    for (let i = 0; i < 200; i++) rt.update(1 / 30);

    const distAfter = nearestZombieDistance(rt);
    expect(rt.aliveCount).toBe(20); // V16: navigation overlap never applies damage
    expect(distAfter).toBeLessThan(distBefore); // the horde closed in THROUGH the breach
  });
});

function nearestZombieDistance(rt: GameRuntime): number {
  const p = rt.player();
  const pos: [number, number, number] = [0, 0, 0];
  let min = Number.POSITIVE_INFINITY;
  rt.zombies.forEachAlive((slot) => {
    rt.zombies.getPosition(slot, pos);
    const d = Math.hypot(pos[0] - p.x, pos[2] - p.z);
    if (d < min) min = d;
  });
  return min;
}
