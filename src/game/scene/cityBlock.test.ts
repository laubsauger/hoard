// T38 — the M1 city-block authored layout: a walkable street wraps a multi-room building whose two rooms
// are split by a destructible wall, with a permanent street door out of the player's room (escape route).

import { describe, it, expect } from 'vitest';
import { buildCityBlock } from './cityBlock';

describe('city block scene (T38 authored content)', () => {
  it('has a street wrapping an enclosed multi-room building', () => {
    const b = buildCityBlock();
    // street corners are open-air (walkable) — the building does not fill the grid.
    const corner = b.cellCenter({ cx: 0, cy: 0 });
    expect(b.isWalkableWorld(corner.x, corner.z)).toBe(true);
    // building perimeter is solid: the top-left building corner cell is blocked.
    const wall = b.cellCenter({ cx: b.buildingBounds.minCx, cy: b.buildingBounds.minCy });
    expect(b.isWalkableWorld(wall.x, wall.z)).toBe(false);
  });

  it('places the player and the horde spawn on walkable interior cells', () => {
    const b = buildCityBlock();
    const p = b.cellCenter(b.playerCell);
    const s = b.cellCenter(b.spawnCenterCell);
    expect(b.isWalkableWorld(p.x, p.z)).toBe(true);
    expect(b.isWalkableWorld(s.x, s.z)).toBe(true);
  });

  it('exposes a walkable escape door from the player room to the street', () => {
    const b = buildCityBlock();
    expect(b.exitCells.length).toBeGreaterThan(0);
    for (const cell of b.exitCells) {
      const c = b.cellCenter(cell);
      expect(b.isWalkableWorld(c.x, c.z)).toBe(true);
      // the cell just outside the door (one cell further out) is open street too.
      const out = b.cellCenter({ cx: cell.cx + 1, cy: cell.cy });
      expect(b.isWalkableWorld(out.x, out.z)).toBe(true);
    }
  });

  it('keeps the destructible section intact (blocked) at build time', () => {
    const b = buildCityBlock();
    for (let z = 0; z < b.wall.sizeZ; z++) {
      const sc = b.wall.packCell(0, 0, z);
      expect(b.wall.isBreached(sc)).toBe(false);
      const navCell = b.navCellForStructuralCell(sc);
      const c = b.cellCenter(navCell);
      expect(b.isWalkableWorld(c.x, c.z)).toBe(false); // intact wall blocks the route
    }
  });
});
