// V14 / V47 — forward vision cone + line-of-sight occlusion. Zombies see a forward cone, not 360°, and
// cannot see the player through walls.
import { describe, it, expect } from 'vitest';
import { withinCone } from './hordeSystems';
import { hasLineOfSight, rayDistanceToWall } from '@/game/scene';

const FOV_HALF = Math.PI / 3; // 120° cone → 60° half

describe('vision cone (V14)', () => {
  it('sees a target dead ahead', () => {
    expect(withinCone(1, 0, 0, FOV_HALF)).toBe(true);
  });
  it('does not see a target directly behind', () => {
    expect(withinCone(-1, 0, 0, FOV_HALF)).toBe(false);
  });
  it('does not see a target at 90° (outside a 60° half-cone)', () => {
    expect(withinCone(0, 1, 0, FOV_HALF)).toBe(false);
  });
  it('a 360° cone (half >= π) sees everything', () => {
    expect(withinCone(-1, 0, 0, Math.PI)).toBe(true);
  });
});

describe('line of sight + wall ray (V47)', () => {
  // A wall slab occupying x in [5, 6].
  const wall = { isWalkableWorld: (x: number, _z: number) => x < 5 || x > 6 };

  it('clear LOS when nothing is between', () => {
    expect(hasLineOfSight(wall, 0, 0, 4, 0)).toBe(true);
  });
  it('blocked LOS through a wall', () => {
    expect(hasLineOfSight(wall, 0, 0, 10, 0)).toBe(false);
  });
  it('ray stops at the wall face', () => {
    const d = rayDistanceToWall(wall, 0, 0, 0, 20);
    expect(d).toBeGreaterThan(4);
    expect(d).toBeLessThanOrEqual(6);
  });
  it('ray returns the cap when the path stays clear', () => {
    expect(rayDistanceToWall(wall, 0, 0, Math.PI, 3)).toBe(3); // heading -x, away from the wall
  });
});
