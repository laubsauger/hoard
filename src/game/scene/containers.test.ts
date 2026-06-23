// T85/B-cupboard — the lootable cupboard resolves to a FIXED interior cell of the player's room (NOT the
// live/spawn player cell), and that cell is walkable + inside the building (so the cabinet never floats in a
// wall and is interactable only when the player walks up to it).
import { describe, it, expect } from 'vitest';
import { buildTestBlock, buildCityDistrict, buildingsOf } from './index';
import { lootableContainerCells } from './containers';

describe('lootable container cell placement (T85)', () => {
  it('anchors the cupboard at a FIXED cell that is NOT the player cell', () => {
    const scene = buildCityDistrict('desktop-high').block;
    const [placement] = lootableContainerCells(scene);
    expect(placement).toBeDefined();
    const c = placement!.cell;
    // the bug: the cupboard tracked the player cell. The fix anchors it elsewhere.
    expect(c.cx === scene.playerCell.cx && c.cy === scene.playerCell.cy).toBe(false);
    expect(placement!.label).toBe('Kitchen Cupboard');
  });

  it('places the cupboard on a WALKABLE interior cell of the player building', () => {
    const scene = buildCityDistrict('desktop-high').block;
    const { cell } = lootableContainerCells(scene)[0]!;
    // walkable (not a wall/partition cell)
    expect(scene.navGrid.isBlocked(scene.navGrid.index(cell.cx, cell.cy))).toBe(false);
    // inside the building that contains the player start cell
    const building = buildingsOf(scene).find(
      (b) =>
        scene.playerCell.cx >= b.bounds.minCx &&
        scene.playerCell.cx <= b.bounds.maxCx &&
        scene.playerCell.cy >= b.bounds.minCy &&
        scene.playerCell.cy <= b.bounds.maxCy,
    );
    expect(building).toBeDefined();
    const b = building!.bounds;
    expect(cell.cx).toBeGreaterThan(b.minCx);
    expect(cell.cx).toBeLessThan(b.maxCx);
    expect(cell.cy).toBeGreaterThan(b.minCy);
    expect(cell.cy).toBeLessThan(b.maxCy);
  });

  it('is deterministic (same scene → same cell) and works for the bare test block too', () => {
    const a = lootableContainerCells(buildCityDistrict('desktop-high').block)[0]!.cell;
    const b = lootableContainerCells(buildCityDistrict('desktop-high').block)[0]!.cell;
    expect(a).toEqual(b);
    const tb = buildTestBlock();
    const [p] = lootableContainerCells(tb);
    expect(p).toBeDefined();
    expect(tb.navGrid.isBlocked(tb.navGrid.index(p!.cell.cx, p!.cell.cy))).toBe(false);
  });
});
