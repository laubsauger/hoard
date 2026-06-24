// T58 / V42 — radius-aware static collision. The body's whole circle (centre + cardinal rim) must clear
// blocked cells, so nothing clips half into a wall.
import { describe, it, expect } from 'vitest';
import { NavGrid } from '@/game/navigation';
import { isWalkableRadius, gridWalkableRadius, circleClearsEdges, gridWalkableWorld } from './testBlock';

/** A scene with a "wall" everywhere at x >= 5. */
const wallAtX5 = { isWalkableWorld: (x: number, _z: number) => x < 5 };

const CS = 2; // navCellSize (default desktop-high)
const center = (c: number) => (c + 0.5) * CS;

describe('isWalkableRadius (T58/V42)', () => {
  it('passes when the whole circle is clear of the wall', () => {
    expect(isWalkableRadius(wallAtX5, 4.0, 0, 0.35)).toBe(true);
  });

  it('rejects when the circle rim pokes into the wall even though the centre is clear', () => {
    // centre 4.8 is walkable, but 4.8 + 0.35 = 5.15 lands in the wall.
    expect(isWalkableRadius(wallAtX5, 4.8, 0, 0.35)).toBe(false);
  });

  it('rejects when the centre itself is blocked', () => {
    expect(isWalkableRadius(wallAtX5, 5.5, 0, 0.35)).toBe(false);
  });
});

// Edge-walls (thin partitions): both cells stay walkable, but a body whose radius pokes ACROSS the walled edge
// overlaps the thin wall and must be rejected — so neither player nor zombie can stand half inside a wall.
describe('radius-aware edge-wall collision', () => {
  const grid = () => {
    const g = new NavGrid({ width: 6, height: 3 });
    g.setWallBetween(2, 1, 3, 1); // wall the edge at x=6 between cell (2,1) and (3,1)
    return g;
  };

  it('circleClearsEdges: body centred away from the wall clears, body poking across it does not', () => {
    const g = grid();
    expect(circleClearsEdges(g, center(2), center(1), 0.35)).toBe(true); // 5±0.35 stays in cell (2,1)
    expect(circleClearsEdges(g, 5.8, center(1), 0.35)).toBe(false); // 5.8+0.35=6.15 → into walled cell (3,1)
  });

  it('gridWalkableRadius rejects a body poking across a walled edge though both cells are walkable', () => {
    const g = grid();
    expect(gridWalkableWorld(g, 5.8, center(1))).toBe(true); // centre cell is walkable
    expect(gridWalkableWorld(g, 6.15, center(1))).toBe(true); // neighbour cell is walkable too
    expect(gridWalkableRadius(g, 5.8, center(1), 0.35)).toBe(false); // …but the body overlaps the wall
    expect(gridWalkableRadius(g, center(2), center(1), 0.35)).toBe(true); // clear of the wall
  });

  it('isWalkableRadius uses the scene navGrid for edge-walls; a mock without one stays cell-only', () => {
    const g = grid();
    const scene = { isWalkableWorld: (x: number, z: number) => gridWalkableWorld(g, x, z), navGrid: g };
    expect(isWalkableRadius(scene, 5.8, center(1), 0.35)).toBe(false); // pokes across the wall → rejected
    expect(isWalkableRadius(scene, center(2), center(1), 0.35)).toBe(true);
    // No navGrid → falls back to cell-only (edge ignored), so the same poke is allowed.
    const cellOnly = { isWalkableWorld: (x: number, z: number) => gridWalkableWorld(g, x, z) };
    expect(isWalkableRadius(cellOnly, 5.8, center(1), 0.35)).toBe(true);
  });
});
