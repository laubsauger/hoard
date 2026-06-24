// P0 edge-walls — sight + sound occlusion across interior partitions (V47/V28). An interior edge-wall is an
// occluder: a ray crossing a walled cell edge is blocked, so a zombie can't see/hear the player through a
// partition — but an open DOORWAY (a clear edge) still passes. Cells stay walkable, so this is occlusion the
// cell-blocking LOS could never express. The narrow vision mocks that expose only isWalkableWorld keep their
// pure cell-occlusion behaviour (no navGrid → no edge test, no throw).

import { describe, it, expect } from 'vitest';
import { NavGrid } from '@/game/navigation';
import { hasLineOfSight, rayDistanceToWall, seesWithinFan } from './testBlock';

const CS = 2; // navCellSize (default desktop-high)
const center = (c: number) => (c + 0.5) * CS;

/** An "everything walkable" scene so ONLY edge-walls can occlude. */
function openScene(grid: NavGrid) {
  return {
    navGrid: grid,
    isWalkableWorld: (x: number, z: number) => {
      const { cx, cy } = grid.worldToCell(x, z);
      return cx >= 0 && cy >= 0 && cx < grid.width && cy < grid.height;
    },
  };
}

describe('hasLineOfSight — interior edge-walls occlude sight + sound (V47/V28)', () => {
  it('FALSE across an interior wall but TRUE through the doorway', () => {
    const g = new NavGrid({ width: 6, height: 3 });
    for (let cy = 0; cy < 3; cy++) if (cy !== 1) g.setWallBetween(2, cy, 3, cy); // doorway gap at cy=1
    const scene = openScene(g);
    expect(hasLineOfSight(scene, center(1), center(0), center(4), center(0))).toBe(false); // across the wall
    expect(hasLineOfSight(scene, center(1), center(1), center(4), center(1))).toBe(true); // through the door
  });

  it('an OPEN edge (no wall) passes — sight is clear where the partition has a gap', () => {
    const g = new NavGrid({ width: 6, height: 3 });
    // wall only the cy=0 seam; cy=1 + cy=2 are open
    g.setWallBetween(2, 0, 3, 0);
    const scene = openScene(g);
    expect(hasLineOfSight(scene, center(1), center(0), center(4), center(0))).toBe(false);
    expect(hasLineOfSight(scene, center(1), center(2), center(4), center(2))).toBe(true);
  });

  it('rayDistanceToWall crops a vision ray at the interior partition', () => {
    const g = new NavGrid({ width: 8, height: 3 });
    for (let cy = 0; cy < 3; cy++) g.setWallBetween(4, cy, 5, cy); // solid partition at the cx=4|5 seam
    const scene = openScene(g);
    // ray fired east from inside cell (1,1) hits the seam between cx=4 and cx=5 → cropped near x=10 (5*CS)
    const d = rayDistanceToWall(scene, center(1), center(1), 0, 20);
    expect(d).toBeLessThan(20);
    expect(d).toBeGreaterThan(6); // it travelled across cells 1..4 before the seam, not stopping immediately
    expect(d).toBeLessThan(9); // and stopped at the 5*CS=10 seam, not beyond
  });

  it('seesWithinFan: a target behind an interior wall is NOT seen; through the doorway it IS', () => {
    const g = new NavGrid({ width: 6, height: 3 });
    for (let cy = 0; cy < 3; cy++) if (cy !== 1) g.setWallBetween(2, cy, 3, cy);
    const scene = openScene(g);
    // omnidirectional (range + LOS only): blocked across the wall row, clear along the doorway row
    expect(seesWithinFan(scene, center(1), center(0), 0, Math.PI, 20, center(4), center(0))).toBe(false);
    expect(seesWithinFan(scene, center(1), center(1), 0, Math.PI, 20, center(4), center(1))).toBe(true);
  });

  it('narrow mocks (isWalkableWorld only) keep pure cell-occlusion with no navGrid', () => {
    const wall = { isWalkableWorld: (x: number) => x < 5 || x > 6 };
    expect(hasLineOfSight(wall, 0, 0, 4, 0)).toBe(true);
    expect(hasLineOfSight(wall, 0, 0, 10, 0)).toBe(false);
    expect(rayDistanceToWall(wall, 0, 0, 0, 20)).toBeCloseTo(5, 0);
  });
});
