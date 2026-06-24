// V53/V42 — generic prop solidity: the SOLID kinds report footprint cells (marked nav-blocked at build so
// shots/movement/sight stop at them); non-solid decor reports none. Plus an integration check that the live
// district actually blocks a car's cell.
import { describe, it, expect } from 'vitest';
import { PROP_SOLIDITY, propBlockedCells, propOccludesSight, propSeeOverCells, setPropSolid } from './propSolidity';
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
    // Footprints rasterize a METRE rectangle into the grid's navCellSize cells — here the world default 1 m.
    const CS = 1;
    expect(propBlockedCells({ kind: 'tire', cx: 5, cy: 5 }, CS)).toEqual([]);
    expect(propBlockedCells({ kind: 'tree', cx: 5, cy: 5 }, CS)).toEqual([{ cx: 5, cy: 5 }]); // trunk = one cell
    // A fence span blocks one cell when PRESENT; a missing span (chance 1 → always missing) is a walkable gap.
    expect(propBlockedCells({ kind: 'fence', cx: 5, cy: 5 }, CS, 0)).toEqual([{ cx: 5, cy: 5 }]); // never missing → blocks
    expect(propBlockedCells({ kind: 'fence', cx: 5, cy: 5 }, CS, 1)).toEqual([]); // always missing → gap
    // car at rot 0 → a car-SHAPED strip: at 1 m it is ~5 cells along its length (local +Z = cy), only 1 cell WIDE.
    const car = propBlockedCells({ kind: 'car', cx: 10, cy: 10 }, CS);
    expect(car.length).toBe(5);
    expect(car).toContainEqual({ cx: 10, cy: 8 });
    expect(car).toContainEqual({ cx: 10, cy: 10 });
    expect(car).toContainEqual({ cx: 10, cy: 12 });
    expect(car.some((c) => c.cx !== 10)).toBe(false); // never widens past the car's 1-cell width
    // rot 90° → the same strip runs along X instead (footprint follows the parked orientation).
    const carRot = propBlockedCells({ kind: 'car', cx: 10, cy: 10, rot: Math.PI / 2 }, CS);
    expect(carRot.length).toBe(5);
    expect(carRot).toContainEqual({ cx: 8, cy: 10 });
    expect(carRot).toContainEqual({ cx: 12, cy: 10 });
    expect(carRot.some((c) => c.cy !== 10)).toBe(false);
    // resolution-independent: the SAME car at the old 2 m grid rasterizes to the old ~3-cell strip (auto-scales).
    const carCoarse = propBlockedCells({ kind: 'car', cx: 10, cy: 10 }, 2);
    expect(carCoarse.length).toBe(3);
    expect(carCoarse).toContainEqual({ cx: 10, cy: 9 });
    expect(carCoarse).toContainEqual({ cx: 10, cy: 11 });
  });

  it('V85 see-over: a sub-eye-height fence is SEEN OVER (sight gap) while tall car/tree occlude; crouching lowers it', () => {
    const eye = 1.6;
    const CS = 1;
    // A waist-high fence (~1 m) is BELOW eye height → does NOT occlude sight; its footprint is a SEE-OVER cell.
    expect(propOccludesSight('fence', eye)).toBe(false);
    expect(propSeeOverCells({ kind: 'fence', cx: 5, cy: 5 }, eye, CS, 0)).toEqual([{ cx: 5, cy: 5 }]);
    // Car + tree are AT/ABOVE eye height → they occlude sight; no see-over cells (vision stops at them).
    expect(propOccludesSight('car', eye)).toBe(true);
    expect(propOccludesSight('tree', eye)).toBe(true);
    expect(propSeeOverCells({ kind: 'car', cx: 10, cy: 10 }, eye, CS)).toEqual([]);
    // Non-solid decor blocks nothing AND is no see-over cell (there is nothing to see over).
    expect(propOccludesSight('tire', eye)).toBe(false);
    expect(propSeeOverCells({ kind: 'tire', cx: 5, cy: 5 }, eye, CS)).toEqual([]);
    // A MISSING fence span (chance 1) is a real walkable gap — not a see-over cell either.
    expect(propSeeOverCells({ kind: 'fence', cx: 5, cy: 5 }, eye, CS, 1)).toEqual([]);
    // CROUCHED (eye 0.8 m < the 1 m fence): you can no longer see over it → it occludes, and you are hidden behind it.
    expect(propOccludesSight('fence', 0.8)).toBe(true);
    expect(propSeeOverCells({ kind: 'fence', cx: 5, cy: 5 }, 0.8, CS, 0)).toEqual([]);
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
