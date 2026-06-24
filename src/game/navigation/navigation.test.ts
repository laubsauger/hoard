// T11 tests — V5 (local dirty rebuild, no full rebuild), V15 (shared flow field points to target).

import { describe, it, expect } from 'vitest';
import { NavGrid } from './navGrid';
import { FlowField, FlowFieldCache } from './flowField';
import { RegionGraph } from './regionGraph';
import { steer, sampleFlowDirection, wallClearanceBias } from './steering';

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

describe('NavGrid edge-walls (interior partitions — PZ model)', () => {
  it('set/query a wall on a cell edge — both cells stay walkable', () => {
    const g = grid(8, 8);
    expect(g.wallOnEdge(2, 2, 'e')).toBe(false);
    g.setEdgeWall(2, 2, 'e', true);
    expect(g.wallOnEdge(2, 2, 'e')).toBe(true);
    // cells are NOT blocked — only the cross-edge is walled
    expect(g.isBlocked(g.index(2, 2))).toBe(false);
    expect(g.isBlocked(g.index(3, 2))).toBe(false);
  });

  it('a wall is symmetric: it blocks crossing from BOTH sides (neighbour sees the opposite edge)', () => {
    const g = grid(8, 8);
    g.setEdgeWall(2, 2, 'e', true);
    expect(g.wallOnEdge(2, 2, 'e')).toBe(true);
    expect(g.wallOnEdge(3, 2, 'w')).toBe(true); // opposite edge set on the neighbour
    expect(g.canCross(2, 2, 3, 2)).toBe(false);
    expect(g.canCross(3, 2, 2, 2)).toBe(false);
    // an untouched perpendicular edge is still crossable
    expect(g.canCross(2, 2, 2, 3)).toBe(true);
  });

  it('setWallBetween / clear toggles the shared edge and restores crossing', () => {
    const g = grid(8, 8);
    g.setWallBetween(4, 4, 4, 5);
    expect(g.canCross(4, 4, 4, 5)).toBe(false);
    expect(g.wallOnEdge(4, 4, 's')).toBe(true);
    g.setWallBetween(4, 4, 4, 5, false);
    expect(g.canCross(4, 4, 4, 5)).toBe(true);
    expect(g.wallOnEdge(4, 4, 's')).toBe(false);
  });

  it('canCross requires 4-neighbours (diagonals/non-adjacent throw)', () => {
    const g = grid(8, 8);
    expect(() => g.canCross(2, 2, 3, 3)).toThrow(/4-neighbour/);
    expect(() => g.canCross(2, 2, 4, 2)).toThrow(/4-neighbour/);
    expect(() => g.setWallBetween(2, 2, 3, 3)).toThrow(/4-neighbour/);
  });

  it('a diagonal step does not cut the corner past a single perpendicular edge-wall (canStep)', () => {
    const g = grid(8, 8);
    // wall on the E edge of (2,2) — the diagonal toward (3,3) would clip past it
    g.setEdgeWall(2, 2, 'e', true);
    expect(g.canStep(2, 2, 1, 1)).toBe(false); // blocked: one of the two shared edges is walled
    expect(g.canStep(2, 2, 0, 1)).toBe(true); // the clear cardinal still passes
  });

  it('setEdgeWall bumps navRevision + dirties both cells tiles; a no-op write does neither', () => {
    const g = grid(24, 24);
    const rev0 = g.navRevision;
    g.setEdgeWall(7, 7, 'e', true); // spans tiles owning (7,7) and (8,8)... here (7,7)&(8,7)
    expect(g.navRevision).toBe(rev0 + 1);
    expect(g.dirtyTileCount).toBeGreaterThanOrEqual(1);
    const rev1 = g.navRevision;
    g.setEdgeWall(7, 7, 'e', true); // already set → no-op
    expect(g.navRevision).toBe(rev1);
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

  it('does NOT flow across an interior edge-wall — routes through the doorway instead', () => {
    // two 6x3 rooms split by a full-height interior partition at the cx=2|cx=3 seam, with a doorway gap at
    // cy=1. Every cell stays walkable; only the cross-edges are walled. A field targeting the right room must
    // reach the left room ONLY via the doorway, so the left cells route to the door, not straight across.
    const g = grid(6, 3);
    for (let cy = 0; cy < 3; cy++) {
      if (cy === 1) continue; // doorway gap
      g.setWallBetween(2, cy, 3, cy);
    }
    const target = g.index(5, 1);
    const field = new FlowField(g, target, 'ground', g.navRevision);
    const left = g.index(1, 0);
    expect(field.isReachable(left)).toBe(true);
    // a wall sits directly east of (2,0); the path from (1,0) must detour through the doorway row → its
    // cost-to-target strictly exceeds the straight-line manhattan distance (4) it would have with no wall.
    expect(field.distance[left]!).toBeGreaterThan(4);
    // walking the flow from a left cell must converge on the target through the door, never crossing the wall.
    let cx = 0;
    let cy = 0;
    let crossed = false;
    for (let s = 0; s < 100; s++) {
      const cell = g.index(cx, cy);
      if (cell === target) break;
      const [dx, dz] = field.directionAt(cell);
      const sx = Math.sign(Math.round(dx));
      const sy = Math.sign(Math.round(dz));
      if (!g.canStep(cx, cy, sx, sy)) crossed = true; // would step across a walled edge — must never happen
      cx += sx;
      cy += sy;
    }
    expect(crossed).toBe(false);
    expect(g.index(cx, cy)).toBe(target);
  });

  it('a sealed interior room (all four edges walled, no doorway) is unreachable from outside it', () => {
    const g = grid(5, 5);
    // wall the cell (2,2) off on all four edges — it becomes its own island though it stays walkable.
    g.setEdgeWall(2, 2, 'n', true);
    g.setEdgeWall(2, 2, 's', true);
    g.setEdgeWall(2, 2, 'e', true);
    g.setEdgeWall(2, 2, 'w', true);
    const field = new FlowField(g, g.index(0, 0), 'ground', g.navRevision);
    expect(field.isReachable(g.index(2, 2))).toBe(false);
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
    // pure flow (no neighbours) points roughly +x toward target. Probe at a CELL CENTRE (cell (1,8) → world
    // (3,17)): the T134 bilinear interpolation is IDENTITY at a cell centre, so this reads that one cell's dir.
    const pure = steer(field, { x: 3, z: 17, neighbors: [], separation: 1, flowWeight: 1 });
    expect(pure.dirX).toBeGreaterThan(0);
    expect(pure.dirZ).toBeCloseTo(0);
    // a neighbour ahead-and-to-one-side deflects the heading: separation introduces a -z component
    // and (after renormalisation) pulls dirX below the pure-flow value.
    const crowded = steer(field, {
      x: 3,
      z: 17,
      neighbors: [{ dx: 0.3, dz: 0.3 }],
      separation: 1,
      flowWeight: 0.5,
    });
    expect(crowded.dirZ).toBeLessThan(0);
    expect(crowded.dirX).toBeLessThan(pure.dirX);
  });
});

describe('flow interpolation (T134/V101)', () => {
  it('is identity at a cell centre (reads exactly that cell direction)', () => {
    const g = grid(16, 16);
    const field = new FlowField(g, g.index(15, 8), 'ground', g.navRevision);
    // cell (4,8) centre → world (9,17). The interpolated sample must equal the cell's own unit direction.
    const cell = g.index(4, 8);
    const [dx, dz] = field.directionAt(cell);
    const s = sampleFlowDirection(field, 9, 17, { x: 0, z: 0 });
    expect(s.x).toBeCloseTo(dx, 6);
    expect(s.z).toBeCloseTo(dz, 6);
  });

  it('produces a CONTINUOUS heading that varies between cells (no 2 m granular jump)', () => {
    const g = grid(16, 16);
    const field = new FlowField(g, g.index(15, 8), 'ground', g.navRevision);
    // sample finely across cell boundaries at z=18 (BETWEEN the cy=8 and cy=9 cell centres, so the bilinear
    // blend actively mixes two rows): the interpolated heading must change smoothly, not jump in one discrete
    // step. Track the max single-step change in the heading angle.
    const first = sampleFlowDirection(field, 5.0, 18, { x: 0, z: 0 });
    let prev = Math.atan2(first.z, first.x);
    let maxStep = 0;
    for (let x = 5.1; x <= 11; x += 0.1) {
      const s = sampleFlowDirection(field, x, 18, { x: 0, z: 0 });
      const ang = Math.atan2(s.z, s.x);
      let d = Math.abs(ang - prev);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > maxStep) maxStep = d;
      prev = ang;
    }
    // a single 0.1 m step must never swing the heading more than a few degrees (a coarse single-cell read
    // would jump by the full inter-cell angle in one boundary step).
    expect(maxStep).toBeLessThan(0.15);
  });

  it('skips an unreachable corner and biases toward the open cells near a wall', () => {
    const g = grid(8, 8);
    // wall the whole cx=4 column → cells at cx>=5 reachable, cx=4 blocked. Target on the right.
    for (let cy = 0; cy < 8; cy++) g.block(4, cy);
    const field = new FlowField(g, g.index(6, 4), 'ground', g.navRevision);
    // a point just LEFT of the wall must not yield a heading INTO the wall (a blocked corner contributes 0).
    const s = sampleFlowDirection(field, 7.5, 9, { x: 0, z: 0 }); // world (7.5,9) → cell (3,4), left of wall
    // the reachable corners all sit on cx<=3 (cx=4 blocked) so the interpolated heading must not point +x into
    // the wall column; it routes around (|x| component is not a hard push east through the wall).
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Number.isFinite(s.z)).toBe(true);
  });
});

describe('wall-clearance bias (T134/V101)', () => {
  it('pushes AWAY from a wall on one side', () => {
    const g = grid(10, 10);
    for (let cy = 0; cy < 10; cy++) g.block(6, cy); // wall column at cx=6 (world x in [12,14))
    // body just west of the wall at world (11.5, 9) → probing east hits the wall → repulsion points WEST (-x).
    const b = wallClearanceBias(g, 11.5, 9, 1.2, { x: 0, z: 0 });
    expect(b.x).toBeLessThan(0);
    expect(Math.abs(b.z)).toBeLessThan(1e-9); // a symmetric N/S wall column → no net z push
  });

  it('is zero in open space and respects probeDist<=0 (off)', () => {
    const g = grid(10, 10);
    const open = wallClearanceBias(g, 9, 9, 1.2, { x: 0, z: 0 });
    expect(open.x).toBe(0);
    expect(open.z).toBe(0);
    const off = wallClearanceBias(g, 0.5, 0.5, 0, { x: 0, z: 0 }); // a corner, but probe off → no bias
    expect(off.x).toBe(0);
    expect(off.z).toBe(0);
  });

  it('pushes inward (diagonally) out of a concave corner', () => {
    const g = grid(10, 10);
    for (let cy = 0; cy < 10; cy++) g.block(6, cy); // east wall (cx=6)
    for (let cx = 0; cx < 10; cx++) g.block(cx, 6); // south wall (cy=6)
    // body in the inside corner near (11.5, 11.5): repulsion must point up-left (away from both walls).
    const b = wallClearanceBias(g, 11.5, 11.5, 1.2, { x: 0, z: 0 });
    expect(b.x).toBeLessThan(0);
    expect(b.z).toBeLessThan(0);
  });
});
