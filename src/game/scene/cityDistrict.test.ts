// T80 — the multi-building suburban DISTRICT: a street grid carrying MANY separately-enterable houses, one
// of which keeps the destructible dividing wall (the §G promise). Asserts the authored layout + the
// extended TestBlock contract (buildings / groundRects / props) the renderer consumes.

import { describe, it, expect } from 'vitest';
import { buildCityDistrict } from './cityDistrict';
import { buildingsOf } from './testBlock';

describe('city district scene (T80 — large multi-building world)', () => {
  it('authors MANY separately-enterable buildings on a street grid', () => {
    const { block } = buildCityDistrict();
    const buildings = buildingsOf(block);
    expect(buildings.length).toBeGreaterThanOrEqual(8); // Project-Zomboid-scale, NOT one house
    // human-scale footprints (~10–18 m wide, ~8–16 m deep at navCellSize 2 m).
    for (const b of buildings) {
      const w = (b.bounds.maxCx - b.bounds.minCx + 1) * block.navGrid.settings.navCellSize;
      const d = (b.bounds.maxCy - b.bounds.minCy + 1) * block.navGrid.settings.navCellSize;
      expect(w).toBeGreaterThanOrEqual(8);
      expect(w).toBeLessThanOrEqual(20);
      expect(d).toBeGreaterThanOrEqual(8);
      expect(d).toBeLessThanOrEqual(20);
    }
  });

  it('buildingBounds is the union bbox covering every building (back-compat accessor)', () => {
    const { block } = buildCityDistrict();
    const bb = block.buildingBounds;
    for (const b of buildingsOf(block)) {
      expect(b.bounds.minCx).toBeGreaterThanOrEqual(bb.minCx);
      expect(b.bounds.minCy).toBeGreaterThanOrEqual(bb.minCy);
      expect(b.bounds.maxCx).toBeLessThanOrEqual(bb.maxCx);
      expect(b.bounds.maxCy).toBeLessThanOrEqual(bb.maxCy);
    }
  });

  it('gives every building a front door; all enterable EXCEPT the player house (starts sheltered/closed)', () => {
    const { block } = buildCityDistrict();
    expect(block.exitCells.length).toBe(buildingsOf(block).length); // one door per building
    const contains = (b: { minCx: number; maxCx: number; minCy: number; maxCy: number }, cell: { cx: number; cy: number }) =>
      cell.cx >= b.minCx && cell.cx <= b.maxCx && cell.cy >= b.minCy && cell.cy <= b.maxCy;
    const playerHouse = buildingsOf(block).find((bld) => contains(bld.bounds, block.playerCell));
    let closed = 0;
    for (const cell of block.exitCells) {
      const c = block.cellCenter(cell);
      const inPlayerHouse = playerHouse ? contains(playerHouse.bounds, cell) : false;
      if (inPlayerHouse) {
        // The player's spawn house starts SHELTERED — its front door begins closed (blocked).
        expect(block.isWalkableWorld(c.x, c.z)).toBe(false);
        closed += 1;
      } else {
        expect(block.isWalkableWorld(c.x, c.z)).toBe(true); // every other house's door gap is walkable
      }
    }
    expect(closed).toBe(1); // exactly the player house is sealed at start
  });

  it('places player + horde spawn on walkable cells (interior vs central green)', () => {
    const { block } = buildCityDistrict();
    const p = block.cellCenter(block.playerCell);
    const s = block.cellCenter(block.spawnCenterCell);
    expect(block.isWalkableWorld(p.x, p.z)).toBe(true);
    expect(block.isWalkableWorld(s.x, s.z)).toBe(true);
  });

  it('keeps the ONE destructible dividing-wall section intact (blocked) at build time', () => {
    const { block } = buildCityDistrict();
    for (let z = 0; z < block.wall.sizeZ; z++) {
      const sc = block.wall.packCell(0, 0, z);
      expect(block.wall.isBreached(sc)).toBe(false);
      const c = block.cellCenter(block.navCellForStructuralCell(sc));
      expect(block.isWalkableWorld(c.x, c.z)).toBe(false); // intact wall blocks the route
    }
  });

  it('lays streaming sectors on walkable open ground (promotion scatter never starts in a wall)', () => {
    const { block, sectors } = buildCityDistrict();
    expect(sectors.length).toBeGreaterThan(0);
    for (const sec of sectors) {
      expect(block.isWalkableWorld(sec.centerX, sec.centerZ)).toBe(true);
    }
  });

  it('emits suburban ground paint + decorative dressing for the renderer (T80 contract)', () => {
    const { block } = buildCityDistrict();
    expect(block.groundRects && block.groundRects.length).toBeGreaterThan(0);
    expect(block.groundRects!.some((r) => r.kind === 'asphalt')).toBe(true);
    expect(block.groundRects!.some((r) => r.kind === 'grass')).toBe(true);
    expect(block.props && block.props.length).toBeGreaterThan(0);
    expect(block.props!.some((p) => p.kind === 'fence')).toBe(true);
    expect(block.props!.some((p) => p.kind === 'car')).toBe(true);
  });
});
