// V53/V42 — generic prop solidity: the SOLID kinds report footprint cells (marked nav-blocked at build so
// shots/movement/sight stop at them); non-solid decor reports none. Plus an integration check that the live
// district actually blocks a car's cell.
import { describe, it, expect } from 'vitest';
import { PROP_SOLIDITY, propBlockedCells, setPropSolid } from './propSolidity';
import { buildCityDistrict } from './cityDistrict';
import { NavGrid } from '@/game/navigation';
import type { PropInstance } from './testBlock';

describe('prop solidity (V53/V42)', () => {
  it('solid kinds (car, tree) report a footprint; soft/thin decor reports none', () => {
    expect(PROP_SOLIDITY.car.solid).toBe(true);
    expect(PROP_SOLIDITY.tree.solid).toBe(true);
    expect(PROP_SOLIDITY.fence.solid).toBe(true); // a picket span blocks (no walking through fences)
    expect(PROP_SOLIDITY.tire.solid).toBe(false);
    expect(PROP_SOLIDITY.bush.solid).toBe(false);
    expect(propBlockedCells({ kind: 'tire', cx: 5, cy: 5 })).toEqual([]);
    expect(propBlockedCells({ kind: 'tree', cx: 5, cy: 5 })).toEqual([{ cx: 5, cy: 5 }]); // trunk = one cell
    // A fence span blocks one cell when PRESENT; a missing span (chance 1 → always missing) is a walkable gap.
    expect(propBlockedCells({ kind: 'fence', cx: 5, cy: 5 }, 0)).toEqual([{ cx: 5, cy: 5 }]); // never missing → blocks
    expect(propBlockedCells({ kind: 'fence', cx: 5, cy: 5 }, 1)).toEqual([]); // always missing → gap
    // car at rot 0 → a car-SHAPED strip: 3 cells along its length (local +Z = cy), only 1 cell WIDE (not 3).
    const car = propBlockedCells({ kind: 'car', cx: 10, cy: 10 });
    expect(car.length).toBe(3);
    expect(car).toContainEqual({ cx: 10, cy: 9 });
    expect(car).toContainEqual({ cx: 10, cy: 10 });
    expect(car).toContainEqual({ cx: 10, cy: 11 });
    expect(car.some((c) => c.cx !== 10)).toBe(false); // never widens past the car's 1-cell width
    // rot 90° → the same strip runs along X instead (footprint follows the parked orientation).
    const carRot = propBlockedCells({ kind: 'car', cx: 10, cy: 10, rot: Math.PI / 2 });
    expect(carRot.length).toBe(3);
    expect(carRot).toContainEqual({ cx: 9, cy: 10 });
    expect(carRot).toContainEqual({ cx: 11, cy: 10 });
  });

  it('the live district marks a car prop nav-BLOCKED so shots/bodies/sight stop at it', () => {
    const { block } = buildCityDistrict();
    const car = block.props?.find((p) => p.kind === 'car');
    expect(car).toBeDefined();
    // The car's own cell is nav-blocked (a shot/body/sight line crossing it now stops). Edge footprint cells
    // may be skipped by the build guard if they hit a doorway/bounds, so assert the centre — the solid core.
    expect(block.navGrid.isBlocked(block.navGrid.index(car!.cx, car!.cy))).toBe(true);
  });

  it('setPropSolid mutates the LIVE grid via V5 local edits — runtime add/remove keeps nav in sync', () => {
    const g = new NavGrid({ width: 32, height: 32 });
    const car: PropInstance = { kind: 'car', cx: 10, cy: 10 };
    const center = g.index(10, 10);
    expect(g.isBlocked(center)).toBe(false);
    const rev0 = g.navRevision;

    // Raise (barricade / authored car): footprint blocks + navRevision bumps so flow fields drop the stale field.
    setPropSolid(g, car, true);
    expect(g.isBlocked(center)).toBe(true);
    expect(g.isBlocked(g.index(10, 11))).toBe(true); // along the car's length (rot 0 → +Z)
    expect(g.isBlocked(g.index(9, 10))).toBe(false); // NOT widened sideways — a car is 1 cell wide
    expect(g.navRevision).toBeGreaterThan(rev0);

    // Remove (car destroyed): the SAME primitive clears the footprint back to walkable — nav re-syncs.
    setPropSolid(g, car, false);
    expect(g.isBlocked(center)).toBe(false);
    expect(g.isBlocked(g.index(10, 11))).toBe(false);

    // skip-guard protects a cell (e.g. a doorway) from being sealed.
    setPropSolid(g, car, true, (cx, cy) => cx === 10 && cy === 10);
    expect(g.isBlocked(center)).toBe(false); // centre protected
    expect(g.isBlocked(g.index(10, 11))).toBe(true); // a length cell still blocked
  });
});
