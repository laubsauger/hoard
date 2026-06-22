// T11 tests — V5 (local dirty rebuild, no full rebuild), V15 (shared flow field points to target).

import { describe, it, expect } from 'vitest';
import { NavGrid } from './navGrid';
import { FlowField, FlowFieldCache } from './flowField';
import { RegionGraph } from './regionGraph';
import { steer } from './steering';

// default nav config: navTileSize 16m / navCellSize 2m -> 8 cells per tile edge.
function grid(w = 24, h = 24): NavGrid {
  return new NavGrid({ width: w, height: h });
}

describe('NavGrid dirty-region tracking (V5)', () => {
  it('derives tile dimensions from config (8 cells/tile by default)', () => {
    const g = grid(24, 24);
    expect(g.tileCells).toBe(8);
    expect(g.tilesX).toBe(3);
    expect(g.tilesY).toBe(3);
  });

  it('a local edit marks ONLY the affected tile dirty and bumps navRevision (no full rebuild)', () => {
    const g = grid(24, 24);
    const rev0 = g.navRevision;
    g.block(1, 1); // tile (0,0)
    expect(g.navRevision).toBe(rev0 + 1);
    expect(g.dirtyTileCount).toBe(1);
    expect(g.dirtyTileList()).toEqual([g.tileOf(1, 1)]);
    // a second edit in a far tile adds exactly one more dirty tile — never the whole grid
    g.block(20, 20); // tile (2,2)
    expect(g.dirtyTileCount).toBe(2);
    expect(g.dirtyTileCount).toBeLessThan(g.tilesX * g.tilesY);
  });

  it('no-op cost write does not dirty or bump revision', () => {
    const g = grid();
    const rev = g.navRevision;
    g.setCost(0, 0, g.getCost(g.index(0, 0))); // same value
    expect(g.navRevision).toBe(rev);
    expect(g.dirtyTileCount).toBe(0);
  });

  it('consumeDirtyTiles clears the set', () => {
    const g = grid();
    g.block(0, 0); // tile (0,0)
    g.block(20, 20); // tile (2,2) — distinct tile
    const consumed = g.consumeDirtyTiles();
    expect(consumed.length).toBe(2);
    expect(g.dirtyTileCount).toBe(0);
  });
});

describe('FlowField shared field (V15)', () => {
  it('every reachable cell, followed by its flow vector, converges on the target', () => {
    const g = grid(16, 16);
    const target = g.index(8, 8);
    const field = new FlowField(g, target, 'ground', g.navRevision);

    // walk from an arbitrary far cell following the flow direction; must reach the target cell
    let cx = 1;
    let cy = 1;
    for (let steps = 0; steps < 200; steps++) {
      const cell = g.index(cx, cy);
      if (cell === target) break;
      const [dx, dz] = field.directionAt(cell);
      // step to the dominant neighbour
      cx += Math.sign(Math.round(dx));
      cy += Math.sign(Math.round(dz));
    }
    expect(g.index(cx, cy)).toBe(target);
  });

  it('routes around a blocking wall (cost gradient respects obstacles)', () => {
    const g = grid(10, 10);
    // vertical wall at cx=5 from cy=0..8, leaving a gap at cy=9
    for (let cy = 0; cy <= 8; cy++) g.block(5, cy);
    const target = g.index(9, 0);
    const field = new FlowField(g, target, 'ground', g.navRevision);
    const start = g.index(0, 0);
    expect(field.isReachable(start)).toBe(true);
    // distance must exceed the straight-line (blocked) cost — proves it went around the gap
    expect(field.distance[start]!).toBeGreaterThan(9);
  });

  it('throws when the target cell is blocked (no silent fallback)', () => {
    const g = grid(8, 8);
    g.block(4, 4);
    expect(() => new FlowField(g, g.index(4, 4), 'ground', g.navRevision)).toThrow(/blocked/);
  });
});

describe('FlowFieldCache keying (target, profile, navRevision)', () => {
  it('reuses a cached field for identical key, recomputes after a nav edit bumps revision', () => {
    const g = grid(12, 12);
    const cache = new FlowFieldCache(4);
    const target = g.index(6, 6);
    const a = cache.get(g, target, 'ground');
    const b = cache.get(g, target, 'ground');
    expect(b).toBe(a); // same instance — cached
    expect(cache.size).toBe(1);

    g.block(0, 0); // bumps navRevision -> new key
    const c = cache.get(g, target, 'ground');
    expect(c).not.toBe(a);
    expect(c.navRevision).toBe(g.navRevision);
  });

  it('differentiates by movement profile', () => {
    const g = grid(8, 8);
    const cache = new FlowFieldCache(4);
    const t = g.index(4, 4);
    const ground = cache.get(g, t, 'ground');
    const crawler = cache.get(g, t, 'crawler');
    expect(crawler).not.toBe(ground);
    expect(cache.size).toBe(2);
  });

  it('evicts least-recently-used beyond capacity', () => {
    const g = grid(8, 8);
    const cache = new FlowFieldCache(2);
    cache.get(g, g.index(1, 1), 'ground');
    cache.get(g, g.index(2, 2), 'ground');
    cache.get(g, g.index(3, 3), 'ground'); // evicts (1,1)
    expect(cache.size).toBe(2);
    expect(cache.has(g.index(1, 1), 'ground', g.navRevision)).toBe(false);
    expect(cache.has(g.index(3, 3), 'ground', g.navRevision)).toBe(true);
  });
});

describe('RegionGraph portals', () => {
  it('routes across open portals and reflects a closed portal', () => {
    const rg = new RegionGraph();
    const p1 = rg.addPortal(0, 1, 10, 1);
    rg.addPortal(1, 2, 20, 1);
    expect(rg.route(0, 2)).toEqual([0, 1, 2]);
    rg.setPortalOpen(p1, false);
    expect(rg.route(0, 2)).toBeNull(); // no open path
  });

  it('returns trivial + unreachable routes correctly', () => {
    const rg = new RegionGraph();
    rg.addRegion(0);
    rg.addRegion(9);
    expect(rg.route(0, 0)).toEqual([0]);
    expect(rg.route(0, 9)).toBeNull();
  });
});

describe('local steering (V19)', () => {
  it('biases toward the flow direction but is pushed by close neighbours', () => {
    const g = grid(16, 16);
    const field = new FlowField(g, g.index(15, 8), 'ground', g.navRevision);
    // pure flow (no neighbours) points roughly +x toward target
    const pure = steer(field, { x: 2, z: 16, neighbors: [], separation: 1, flowWeight: 1 });
    expect(pure.dirX).toBeGreaterThan(0);
    expect(pure.dirZ).toBeCloseTo(0);
    // a neighbour ahead-and-to-one-side deflects the heading: separation introduces a -z component
    // and (after renormalisation) pulls dirX below the pure-flow value.
    const crowded = steer(field, {
      x: 2,
      z: 16,
      neighbors: [{ dx: 0.3, dz: 0.3 }],
      separation: 1,
      flowWeight: 0.5,
    });
    expect(crowded.dirZ).toBeLessThan(0);
    expect(crowded.dirX).toBeLessThan(pure.dirX);
  });
});
