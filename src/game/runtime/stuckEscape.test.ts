// T134/V101 — the PURE pieces of the coarse-pathing fix: the deterministic stuck-escape direction selection
// (wall-follow fan) and the radius-aware spawn-clamp-to-walkable snap. Both are pure functions of their inputs
// (no RNG, V26) so a replay routes + spawns identically.

import { describe, it, expect } from 'vitest';
import { selectEscapeDir, STUCK_ESCAPE_FAN } from './hordeSystems';
import { NavGrid } from '@/game/navigation';
import { nearestWalkablePoint } from '@/game/scene';

const CS = 2; // navCellSize (default desktop-high)
const center = (c: number): number => (c + 0.5) * CS;

describe('stuck-escape direction selection (T134/V101)', () => {
  it('the fan is the documented 6-direction set (±30/±60/±90), unit-length, nearest-first', () => {
    expect(STUCK_ESCAPE_FAN.length).toBe(6);
    for (const r of STUCK_ESCAPE_FAN) {
      expect(Math.hypot(r.cos, r.sin)).toBeCloseTo(1, 9); // cos²+sin² = 1
    }
    // first offset is +30°, second -30° (alternating sides, nearest the heading first).
    expect(Math.atan2(STUCK_ESCAPE_FAN[0]!.sin, STUCK_ESCAPE_FAN[0]!.cos)).toBeCloseTo(Math.PI / 6, 6);
    expect(Math.atan2(STUCK_ESCAPE_FAN[1]!.sin, STUCK_ESCAPE_FAN[1]!.cos)).toBeCloseTo(-Math.PI / 6, 6);
  });

  it('returns null when EVERY fan direction is blocked (a genuine dead-end)', () => {
    expect(selectEscapeDir(1, 0, () => false)).toBeNull();
  });

  it('picks the FIRST clear rotated heading, preserving unit length', () => {
    // desired heading +x; block the first two (+30/-30) so the +60° rotation wins.
    const sixty = STUCK_ESCAPE_FAN[2]!;
    const want = { dirX: sixty.cos, dirZ: sixty.sin }; // rotating (1,0) by +60° → (cos60, sin60)
    let calls = 0;
    const got = selectEscapeDir(1, 0, () => {
      calls += 1;
      return calls === 3; // accept only the 3rd candidate (+60°)
    });
    expect(got).not.toBeNull();
    expect(got!.dirX).toBeCloseTo(want.dirX, 6);
    expect(got!.dirZ).toBeCloseTo(want.dirZ, 6);
    expect(Math.hypot(got!.dirX, got!.dirZ)).toBeCloseTo(1, 9); // unit → same locomotion speed
  });

  it('wall-follows: with a wall to the right, the body turns the OTHER way deterministically', () => {
    // heading +x into a wall; "clear" only when the rotated step turns toward -z (turning left/away).
    const got = selectEscapeDir(1, 0, (edx, edz) => edz < 0);
    expect(got).not.toBeNull();
    expect(got!.dirZ).toBeLessThan(0); // chose the -z side
    // and it is the NEAREST such offset (-30°), not a wider one.
    expect(Math.atan2(got!.dirZ, got!.dirX)).toBeCloseTo(-Math.PI / 6, 6);
  });
});

describe('spawn-clamp to nearest walkable (T134/V101)', () => {
  /** A scene over a NavGrid: cellCenter + isWalkableWorld read the grid (one source of truth). */
  function scene(g: NavGrid) {
    return {
      navGrid: g,
      cellCenter: (c: { cx: number; cy: number }) => ({ x: center(c.cx), y: 0, z: center(c.cy) }),
      isWalkableWorld: (x: number, z: number) => {
        const { cx, cy } = g.worldToCell(x, z);
        if (cx < 0 || cy < 0 || cx >= g.width || cy >= g.height) return false;
        return !g.isBlocked(g.index(cx, cy));
      },
    };
  }

  it('returns an already-walkable position UNCHANGED (the common scatter path is a no-op)', () => {
    const g = new NavGrid({ width: 10, height: 10 });
    const s = scene(g);
    const p = nearestWalkablePoint(s, 9, 9, 0.35, 24);
    expect(p.x).toBe(9);
    expect(p.z).toBe(9);
  });

  it('snaps a position embedded in a blocked cell to the nearest walkable cell centre', () => {
    const g = new NavGrid({ width: 10, height: 10 });
    g.block(5, 5); // a wall/furniture cell
    const s = scene(g);
    // spawn at the centre of the blocked cell (5,5) → world (11,11). Must snap OUT to an adjacent walkable cell.
    const p = nearestWalkablePoint(s, center(5), center(5), 0.35, 24);
    expect(s.isWalkableWorld(p.x, p.z)).toBe(true);
    const cell = g.worldToCell(p.x, p.z);
    expect(g.isBlocked(g.index(cell.cx, cell.cy))).toBe(false);
    // it is a cell ADJACENT to (5,5) (Chebyshev distance 1 — the nearest ring), deterministic.
    expect(Math.max(Math.abs(cell.cx - 5), Math.abs(cell.cy - 5))).toBe(1);
  });

  it('is DETERMINISTIC — the same blocked spawn always snaps to the same cell', () => {
    const g = new NavGrid({ width: 10, height: 10 });
    g.block(5, 5);
    const s = scene(g);
    const a = nearestWalkablePoint(s, center(5), center(5), 0.35, 24);
    const b = nearestWalkablePoint(s, center(5), center(5), 0.35, 24);
    expect(a).toEqual(b);
  });

  it('is radius-aware: a wide body snaps to a cell whose whole circle clears the wall', () => {
    const g = new NavGrid({ width: 12, height: 12 });
    // a 2-cell-thick wall band at cx=5..6 → an adjacent cell centre may still have its rim poke into the wall.
    for (let cy = 0; cy < 12; cy++) {
      g.block(5, cy);
      g.block(6, cy);
    }
    const s = scene(g);
    const r = 0.9; // a wide body
    const p = nearestWalkablePoint(s, center(5), center(5), r, 24);
    // the chosen point must clear the body radius (centre + rim all walkable), not merely sit on a walkable cell.
    expect(s.isWalkableWorld(p.x + r, p.z)).toBe(true);
    expect(s.isWalkableWorld(p.x - r, p.z)).toBe(true);
  });

  it('throws (no silent drop) when no walkable cell lies within the ring budget', () => {
    const g = new NavGrid({ width: 6, height: 6 });
    for (let cx = 0; cx < 6; cx++) for (let cy = 0; cy < 6; cy++) g.block(cx, cy); // everything blocked
    const s = scene(g);
    expect(() => nearestWalkablePoint(s, center(3), center(3), 0.35, 8)).toThrow(/no walkable cell/);
  });
});
