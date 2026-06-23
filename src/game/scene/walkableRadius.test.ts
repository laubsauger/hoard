// T58 / V42 — radius-aware static collision. The body's whole circle (centre + cardinal rim) must clear
// blocked cells, so nothing clips half into a wall.
import { describe, it, expect } from 'vitest';
import { isWalkableRadius } from './testBlock';

/** A scene with a "wall" everywhere at x >= 5. */
const wallAtX5 = { isWalkableWorld: (x: number, _z: number) => x < 5 };

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
