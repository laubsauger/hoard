// T46 — door state system: a closed door blocks nav + sight + sound through its cell; opening clears it.
import { describe, it, expect } from 'vitest';
import { NavGrid } from '@/game/navigation';
import { DoorSystem, doorAxis, doorAxisForDir, isDoorCell } from './doors';
import { hasLineOfSight } from './testBlock';

/** A 7-wide wall along cy=3 with a single door gap at cx=3, rooms above (cy<3) and below (cy>3). */
function wallWithDoor(): { grid: NavGrid; door: { cx: number; cy: number } } {
  const grid = new NavGrid({ width: 7, height: 7 });
  const door = { cx: 3, cy: 3 };
  for (let cx = 0; cx < 7; cx++) {
    if (cx === door.cx) continue; // leave the doorway open initially
    grid.block(cx, 3);
  }
  return { grid, door };
}

describe('DoorSystem (T46)', () => {
  it('a doorway omits its wall panel — the door cell is a real opening', () => {
    const { grid, door } = wallWithDoor();
    expect(grid.isBlocked(grid.index(door.cx, door.cy))).toBe(false); // gap exists
    expect(isDoorCell([door], door.cx, door.cy)).toBe(true);
    expect(isDoorCell([door], door.cx + 1, door.cy)).toBe(false);
  });

  it('doorAxis follows the wall run (blocked left/right neighbours ⇒ X-run)', () => {
    const { grid, door } = wallWithDoor();
    expect(doorAxis(grid, door.cx, door.cy)).toBe('x'); // wall runs along X
  });

  it('a closed door BLOCKS nav + sight through its cell; opening CLEARS it', () => {
    const { grid, door } = wallWithDoor();
    const doors = new DoorSystem(grid, [door]);
    const navCell = grid.index(door.cx, door.cy);
    const scene = { isWalkableWorld: (x: number, z: number) => {
      const { cx, cy } = grid.worldToCell(x, z);
      if (cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height) return false;
      return !grid.isBlocked(grid.index(cx, cy));
    } };
    const cs = grid.settings.navCellSize;
    const above = { x: (door.cx + 0.5) * cs, z: (door.cy - 1 + 0.5) * cs };
    const below = { x: (door.cx + 0.5) * cs, z: (door.cy + 1 + 0.5) * cs };

    // starts open (the authored gap): nav passable + line-of-sight clear through the door.
    expect(doors.accessOf(navCell)).toBe('open');
    expect(grid.isBlocked(navCell)).toBe(false);
    expect(hasLineOfSight(scene, above.x, above.z, below.x, below.z)).toBe(true);

    // close it → nav blocked + sight blocked.
    expect(doors.close(navCell)).toBe(true);
    expect(doors.accessOf(navCell)).toBe('closed');
    expect(grid.isBlocked(navCell)).toBe(true);
    expect(hasLineOfSight(scene, above.x, above.z, below.x, below.z)).toBe(false);

    // open it again → cleared.
    expect(doors.open(navCell)).toBe(true);
    expect(grid.isBlocked(navCell)).toBe(false);
    expect(hasLineOfSight(scene, above.x, above.z, below.x, below.z)).toBe(true);
  });

  it('toggle flips open↔closed and reports the resulting access', () => {
    const { grid, door } = wallWithDoor();
    const doors = new DoorSystem(grid, [door]);
    const navCell = grid.index(door.cx, door.cy);
    expect(doors.toggle(navCell)).toBe('closed');
    expect(doors.toggle(navCell)).toBe('open');
  });

  it('initial access is read from the authored grid (a blocked door cell starts closed)', () => {
    const grid = new NavGrid({ width: 7, height: 7 });
    for (let cx = 0; cx < 7; cx++) grid.block(cx, 3); // door cell starts blocked = closed
    const door = { cx: 3, cy: 3 };
    const doors = new DoorSystem(grid, [door]);
    expect(doors.accessOf(grid.index(door.cx, door.cy))).toBe('closed');
  });

  it('doorAxisForDir derives the leaf axis from the edge direction', () => {
    expect(doorAxisForDir('n')).toBe('x'); // n/s wall runs along X (leaf faces ±Z)
    expect(doorAxisForDir('s')).toBe('x');
    expect(doorAxisForDir('e')).toBe('z'); // e/w wall runs along Z
    expect(doorAxisForDir('w')).toBe('z');
  });

  it('an EDGE-door toggles the cell EDGE-wall, not the cell — both cells stay walkable', () => {
    // two adjacent open cells; the door is the edge between (3,3) and the cell to its south (3,4).
    const grid = new NavGrid({ width: 7, height: 7 });
    const inner = { cx: 3, cy: 3 };
    const outer = { cx: 3, cy: 4 };
    const doors = new DoorSystem(grid, [{ cx: inner.cx, cy: inner.cy, edgeDir: 's' }]);
    const navCell = grid.index(inner.cx, inner.cy);
    const scene = {
      isWalkableWorld: (x: number, z: number) => {
        const { cx, cy } = grid.worldToCell(x, z);
        if (cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height) return false;
        return !grid.isBlocked(grid.index(cx, cy));
      },
      navGrid: grid,
    };
    const cs = grid.settings.navCellSize;
    const a = { x: (inner.cx + 0.5) * cs, z: (inner.cy + 0.5) * cs };
    const b = { x: (outer.cx + 0.5) * cs, z: (outer.cy + 0.5) * cs };

    // authored clear edge ⇒ open: both cells walkable, edge clear, sight passes.
    expect(doors.accessOf(navCell)).toBe('open');
    expect(grid.wallOnEdge(inner.cx, inner.cy, 's')).toBe(false);
    expect(hasLineOfSight(scene, a.x, a.z, b.x, b.z)).toBe(true);

    // close ⇒ the EDGE is walled (cells still walkable), sight + crossing blocked, cell never blocked.
    expect(doors.close(navCell)).toBe(true);
    expect(doors.accessOf(navCell)).toBe('closed');
    expect(grid.wallOnEdge(inner.cx, inner.cy, 's')).toBe(true);
    expect(grid.isBlocked(navCell)).toBe(false); // the CELL is untouched — edge-door, not cell-door
    expect(grid.isBlocked(grid.index(outer.cx, outer.cy))).toBe(false);
    expect(grid.canStep(inner.cx, inner.cy, 0, 1)).toBe(false); // cannot cross the walled edge
    expect(hasLineOfSight(scene, a.x, a.z, b.x, b.z)).toBe(false);

    // open again ⇒ edge cleared.
    expect(doors.open(navCell)).toBe(true);
    expect(grid.wallOnEdge(inner.cx, inner.cy, 's')).toBe(false);
    expect(grid.canStep(inner.cx, inner.cy, 0, 1)).toBe(true);
    expect(hasLineOfSight(scene, a.x, a.z, b.x, b.z)).toBe(true);
  });

  it('an EDGE-door reads its initial access from the authored edge-wall + reports its dir + edge-midpoint centre', () => {
    const grid = new NavGrid({ width: 7, height: 7 });
    grid.setWallBetween(3, 3, 4, 3, true); // pre-walled edge toward 'e' ⇒ starts closed
    const doors = new DoorSystem(grid, [{ cx: 3, cy: 3, edgeDir: 'e' }]);
    const navCell = grid.index(3, 3);
    expect(doors.accessOf(navCell)).toBe('closed');
    const view = doors.list()[0]!;
    expect(view.dir).toBe('e');
    expect(view.axis).toBe('z');
    const cs = grid.settings.navCellSize;
    expect(view.x).toBeCloseTo((3 + 1) * cs); // edge midpoint sits on the cell boundary toward 'e'
    expect(view.z).toBeCloseTo((3 + 0.5) * cs);
  });

  it('nearest returns the closest door in reach, none beyond range', () => {
    const grid = new NavGrid({ width: 12, height: 12 });
    const a = { cx: 2, cy: 2 };
    const b = { cx: 9, cy: 9 };
    const doors = new DoorSystem(grid, [a, b]);
    const cs = grid.settings.navCellSize;
    const near = doors.nearest((a.cx + 0.5) * cs, (a.cy + 0.5) * cs, 3);
    expect(near?.door.cx).toBe(a.cx);
    expect(doors.nearest(0, 0, 0.5)).toBeNull(); // origin corner — nothing in 0.5 m reach
  });
});
