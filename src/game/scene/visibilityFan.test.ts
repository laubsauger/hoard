// T68/V47 — visibility fan: deformed (wall-hugging) polygon + the seesWithinFan logic agree.
import { describe, it, expect } from 'vitest';
import { castVisibilityFan, seesWithinFan } from './testBlock';

// A wall slab at x in [5,6]; open elsewhere.
const wall = { isWalkableWorld: (x: number, _z: number) => x < 5 || x > 6 };

describe('visibility fan (T68/V47)', () => {
  it('deforms: rays toward the wall are clipped short, rays into the open reach full range', () => {
    // facing +x (toward the wall) from origin, 90° cone, range 20.
    const fan = castVisibilityFan(wall, 0, 0, 0, Math.PI / 2, 20, 16);
    const min = Math.min(...fan);
    const max = Math.max(...fan);
    expect(min).toBeLessThan(6); // the dead-ahead rays hit the wall (~5)
    expect(max).toBeGreaterThan(10); // the angled rays slip past the slab and reach far
    expect(max - min).toBeGreaterThan(4); // genuinely DEFORMED, not a uniform radius
  });

  it('seesWithinFan agrees: a target behind the wall is NOT seen; one in the open IS', () => {
    expect(seesWithinFan(wall, 0, 0, 0, Math.PI / 2, 20, 10, 0)).toBe(false); // behind the wall
    expect(seesWithinFan(wall, 0, 0, 0, Math.PI / 2, 20, 4, 0)).toBe(true); // clear ahead
    expect(seesWithinFan(wall, 0, 0, 0, Math.PI / 2, 20, -4, 0)).toBe(false); // behind the agent (outside cone)
  });
});
