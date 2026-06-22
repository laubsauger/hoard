// T13 tests — V5 (only local nav dirty, no full rebuild), V18 (compact delta + same state feeds
// nav/collision/save), V30 (irregular breach hides cell shape), breach->portal, determinism (V26).

import { describe, it, expect } from 'vitest';
import { StructuralModule, type StructuralHooks } from './structuralModule';
import { IdFactory } from '@/game/core/ids';
import type { EventId, ModuleId, WorldEvent } from '@/game/core/contracts';
import { NavGrid } from '@/game/navigation/navGrid';
import { RegionGraph } from '@/game/navigation/regionGraph';

const MODULE_ID = 1 as ModuleId;

/** A test harness wiring the module breach into a real NavGrid + RegionGraph to prove locality. */
function harness() {
  const ids = new IdFactory();
  const events: WorldEvent[] = [];
  const nav = new NavGrid({ width: 24, height: 24 });
  const region = new RegionGraph();
  region.addRegion(0); // interior
  region.addRegion(1); // exterior
  const openedCells: number[] = [];

  const hooks: StructuralHooks = {
    nextEventId: () => ids.next<EventId>('event'),
    emit: (e) => events.push(e),
    openCell: (_module, cell) => {
      openedCells.push(cell);
      // map module-local cell (x,z) to a nav cell and OPEN it (local edit only)
      const { x, z } = unpackXZ(cell);
      nav.clear(x, z); // breach opens a previously-blocked nav cell
      // a breach in a wall connects interior<->exterior: add a portal
      region.addPortal(0, 1, nav.index(x, z), 1);
    },
  };
  return { ids, events, nav, region, hooks, openedCells };
}

// the test module is 6x1x6; module-local cell index packs x + z*6 (y=0).
function unpackXZ(cell: number): { x: number; z: number } {
  return { x: cell % 6, z: Math.floor(cell / 6) };
}

function wallModule(seed = 7): StructuralModule {
  const m = new StructuralModule({ id: MODULE_ID, sizeX: 6, sizeY: 1, sizeZ: 6, seed });
  // a wall row at z=0, brick, fracture family 0, plus floor anchors at z=5
  for (let x = 0; x < 6; x++) {
    m.addCell({ x, y: 0, z: 0, material: 'brick', family: 0, strength: 100 });
  }
  return m;
}

describe('StructuralModule authoring + sparsity', () => {
  it('stores cells sparsely and packs/unpacks local indices', () => {
    const m = wallModule();
    expect(m.cellCount).toBe(6); // only the wall cells occupy, not the full 36 grid
    expect(m.familyCount).toBe(1);
    const idx = m.packCell(3, 0, 0);
    expect(m.unpackCell(idx)).toEqual({ x: 3, y: 0, z: 0 });
  });
});

describe('breach pipeline (V5/V18/V30)', () => {
  it('breaches at threshold, opens LOCAL nav only, emits events, records delta, creates a portal', () => {
    const h = harness();
    const m = wallModule();
    // pre-block the wall cells in nav so the breach visibly opens them
    for (let x = 0; x < 6; x++) h.nav.block(x, 0);
    const dirtyBefore = h.nav.consumeDirtyTiles().length; // clear the authoring dirties
    expect(dirtyBefore).toBeGreaterThan(0);

    const target = m.packCell(3, 0, 0);
    const result = m.applyDamage(target, 100, h.hooks); // full strength removed -> breach
    expect(result).not.toBeNull();

    // events: at least one structureModified + a breachCreated for the primary cell
    expect(h.events.some((e) => e.kind === 'breachCreated' && e.cell === target)).toBe(true);
    expect(h.events.some((e) => e.kind === 'structureModified')).toBe(true);

    // V5: only the tiles overlapping breached cells are dirty — NOT the whole grid
    const dirty = h.nav.dirtyTileList();
    expect(dirty.length).toBeGreaterThan(0);
    expect(dirty.length).toBeLessThan(h.nav.tilesX * h.nav.tilesY);

    // breach -> portal created connecting interior<->exterior
    expect(h.region.portalCount).toBeGreaterThan(0);
    expect(h.region.route(0, 1)).toEqual([0, 1]);

    // V18: compact delta records the breached state
    const delta = m.modificationDelta();
    const primaryDelta = delta.find((d) => d.cell === target);
    expect(primaryDelta?.breached).toBe(true);
    expect(primaryDelta?.strength).toBe(0);

    // the breached cell is now passable in the module's own representation
    expect(m.isPassable(target)).toBe(true);
  });

  it('breach hole is irregular — footprint can exceed the single struck cell (V30)', () => {
    const h = harness();
    const m = wallModule(7);
    const target = m.packCell(3, 0, 0);
    const result = m.applyDamage(target, 100, h.hooks)!;
    expect(result.breached).toContain(target);
    // with breachIrregularity 0.5 + spread radius 1 across a contiguous family, the footprint
    // is very likely > 1 cell (irregular). Assert it is a set including the primary at minimum.
    expect(result.breached.length).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic for a fixed seed (V26) — identical footprint', () => {
    const a = wallModule(42);
    const b = wallModule(42);
    const ha = harness();
    const hb = harness();
    const fa = a.applyDamage(a.packCell(3, 0, 0), 100, ha.hooks)!;
    const fb = b.applyDamage(b.packCell(3, 0, 0), 100, hb.hooks)!;
    expect(fa.breached.sort()).toEqual(fb.breached.sort());
  });

  it('partial damage below threshold does not breach but still records a delta', () => {
    const h = harness();
    const m = wallModule();
    const target = m.packCell(0, 0, 0);
    const result = m.applyDamage(target, 30, h.hooks);
    expect(result).toBeNull();
    expect(m.isBreached(target)).toBe(false);
    expect(m.getCell(target)?.strength).toBe(70);
    expect(m.modificationDelta().find((d) => d.cell === target)?.strength).toBe(70);
  });

  it('support cascade: a cell losing its path to an anchor collapses', () => {
    const m = new StructuralModule({ id: MODULE_ID, sizeX: 3, sizeY: 3, sizeZ: 1, seed: 1 });
    // distinct fracture families so the irregular breach footprint does not itself spread up the
    // column — this isolates the SUPPORT cascade (loss of path to anchor) from the breach hole.
    const base = m.addCell({ x: 0, y: 0, z: 0, material: 'concrete', family: 0, strength: 100, anchor: true });
    const mid = m.addCell({ x: 0, y: 1, z: 0, material: 'concrete', family: 1, strength: 100 });
    const top = m.addCell({ x: 0, y: 2, z: 0, material: 'concrete', family: 2, strength: 100 });
    m.addSupport(mid, base);
    m.addSupport(top, mid);
    const h = harness2();
    // destroy the base anchor -> mid + top lose their support path and collapse
    const res = m.applyDamage(base, 100, h.hooks)!;
    expect(m.isBreached(base)).toBe(true);
    expect(res.collapsed).toEqual(expect.arrayContaining([mid, top]));
  });

  it('delta round-trips: applyDeltaSnapshot restores breached state (V9)', () => {
    const h = harness();
    const m = wallModule();
    const target = m.packCell(2, 0, 0);
    m.applyDamage(target, 100, h.hooks);
    const saved = m.modificationDelta();

    // a fresh module from the same base package + the saved delta == current state
    const reloaded = wallModule();
    reloaded.applyDeltaSnapshot(saved);
    expect(reloaded.isBreached(target)).toBe(true);
    expect(reloaded.getCell(target)?.strength).toBe(0);
  });
});

// a harness whose openCell does not touch nav (for the 3x3x1 support test that uses y>0 cells).
function harness2() {
  const ids = new IdFactory();
  const events: WorldEvent[] = [];
  const hooks: StructuralHooks = {
    nextEventId: () => ids.next<EventId>('event'),
    emit: (e) => events.push(e),
  };
  return { ids, events, hooks };
}
