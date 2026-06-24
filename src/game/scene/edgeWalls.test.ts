// P0 edge-walls — the cross-edge MOVEMENT gate interior partitions ride on. Cells stay walkable (the PZ
// model); only crossing a walled cell EDGE is blocked. `segmentCrossesWall` is the primitive both the zombie
// steering (hordeSystems.stepMovement) and the player move (gameRuntime.movePlayer) use to reject a per-tick
// step through a partition.

import { describe, it, expect } from 'vitest';
import { NavGrid } from '@/game/navigation';
import { segmentCrossesWall } from './testBlock';

const CS = 2; // navCellSize (default desktop-high)
const center = (c: number) => (c + 0.5) * CS;

describe('segmentCrossesWall — per-tick movement gate (steering V19 + player)', () => {
  it('a move crossing a walled edge is blocked; the same move with no wall is allowed', () => {
    const g = new NavGrid({ width: 6, height: 3 });
    g.setWallBetween(2, 1, 3, 1); // wall the edge between cell (2,1) and (3,1)
    // a body at the centre of (2,1) told to step east into (3,1) would cross the partition → blocked
    expect(segmentCrossesWall(g, center(2), center(1), center(3), center(1))).toBe(true);
    // a parallel seam one row up has no wall → the same axis move is clear
    expect(segmentCrossesWall(g, center(2), center(0), center(3), center(0))).toBe(false);
  });

  it('moving along a wall (parallel, same cell column) does NOT register a crossing', () => {
    const g = new NavGrid({ width: 6, height: 3 });
    g.setWallBetween(2, 1, 3, 1);
    // travel north→south within column cx=2 — never crosses the cx=2|3 seam
    expect(segmentCrossesWall(g, center(2), center(0), center(2), center(2))).toBe(false);
  });

  it('a doorway gap in a partition lets the move through', () => {
    const g = new NavGrid({ width: 6, height: 3 });
    for (let cy = 0; cy < 3; cy++) if (cy !== 1) g.setWallBetween(2, cy, 3, cy); // gap at cy=1
    expect(segmentCrossesWall(g, center(2), center(0), center(3), center(0))).toBe(true); // through the wall
    expect(segmentCrossesWall(g, center(2), center(1), center(3), center(1))).toBe(false); // through the door
  });

  it('a sub-cell step that does not leave the cell never reports a crossing', () => {
    const g = new NavGrid({ width: 6, height: 3 });
    g.setWallBetween(2, 1, 3, 1);
    expect(segmentCrossesWall(g, center(2), center(1), center(2) + 0.3, center(1) + 0.2)).toBe(false);
  });

  it('a diagonal step cannot cut the corner past a partition', () => {
    const g = new NavGrid({ width: 6, height: 6 });
    g.setWallBetween(2, 2, 3, 2); // wall east of (2,2)
    // diagonal from (2,2) toward (3,3) clips the walled corner → blocked
    expect(segmentCrossesWall(g, center(2), center(2), center(3), center(3))).toBe(true);
  });
});
