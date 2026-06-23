// B4 / V19 tests — hard min-spacing penetration resolution.
// Invariants covered:
//  - overlapping visible-tier bodies are pushed to >= min spacing,
//  - bodies already >= min spacing are untouched (none reported moved),
//  - resolution never commits a push onto a non-walkable cell (walkable stays authoritative),
//  - coincident bodies separate deterministically (no NaN / division blow-up),
//  - agents outside the provided set act as immovable obstacles (tier exemption semantics),
//  - a tight doorway still lets a stacked queue spread without leaving the corridor or exploding.

import { describe, it, expect } from 'vitest';
import { resolveSeparation, type SeparationAgent } from './separation';

const RADIUS = 0.35;
const ALWAYS_WALKABLE = () => true;

function agent(id: number, x: number, z: number, radius = RADIUS): SeparationAgent {
  return { id, x, z, radius };
}

/** All-pairs neighbour lookup over a fixed agent list (simple + exhaustive for unit tests). */
function allPairs(list: readonly SeparationAgent[]) {
  return (a: SeparationAgent) => list.filter((b) => b.id !== a.id);
}

function dist(a: SeparationAgent, b: SeparationAgent): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

describe('resolveSeparation (B4 / V19)', () => {
  it('pushes two overlapping bodies apart to >= min spacing', () => {
    const a = agent(1, 0, 0);
    const b = agent(2, 0.2, 0); // overlapping: 0.2 < min spacing 0.7
    const list = [a, b];
    const minDist = 1 * (a.radius + b.radius);
    const moved = resolveSeparation(list, allPairs(list), ALWAYS_WALKABLE, {
      iterations: 12,
      minSpacingScale: 1,
    });
    expect(dist(a, b)).toBeGreaterThanOrEqual(minDist - 1e-3);
    expect(moved).toEqual(new Set([1, 2]));
  });

  it('leaves bodies already at/over min spacing untouched', () => {
    const a = agent(1, 0, 0);
    const b = agent(2, 2, 0); // far apart
    const list = [a, b];
    const moved = resolveSeparation(list, allPairs(list), ALWAYS_WALKABLE, {
      iterations: 4,
      minSpacingScale: 1,
    });
    expect(moved.size).toBe(0);
    expect(a.x).toBe(0);
    expect(b.x).toBe(2);
  });

  it('never commits a push onto a non-walkable cell (walkable stays authoritative)', () => {
    // Wall at x < 0: A would be pushed into it and must stay put; B is free to move out.
    const isWalkable = (x: number) => x >= 0;
    const a = agent(1, 0, 0);
    const b = agent(2, 0.2, 0);
    const list = [a, b];
    resolveSeparation(list, allPairs(list), isWalkable, { iterations: 12, minSpacingScale: 1 });
    expect(a.x).toBeGreaterThanOrEqual(0); // never shoved through the wall
    expect(isWalkable(a.x)).toBe(true);
    expect(isWalkable(b.x)).toBe(true);
  });

  it('separates exactly-coincident bodies deterministically (no NaN)', () => {
    const a = agent(1, 5, 5);
    const b = agent(2, 5, 5); // identical position
    const list = [a, b];
    resolveSeparation(list, allPairs(list), ALWAYS_WALKABLE, { iterations: 12, minSpacingScale: 1 });
    expect(Number.isFinite(a.x)).toBe(true);
    expect(Number.isFinite(b.x)).toBe(true);
    expect(dist(a, b)).toBeGreaterThan(0); // lower-id pushed +x, higher-id pushed -x
    expect(a.x).toBeGreaterThan(b.x);
  });

  it('treats agents outside the resolved set as immovable (tier-exemption semantics)', () => {
    // `obstacle` models an abstract-tier body the caller left OUT of the resolved set: it is visible to
    // the neighbour query but never itself moved. The visible body must push off it without moving it.
    const visible = agent(1, 0.2, 0);
    const obstacle = agent(2, 0, 0);
    const resolved = [visible]; // only the visible-tier body participates
    const moved = resolveSeparation(
      resolved,
      () => [obstacle],
      ALWAYS_WALKABLE,
      { iterations: 12, minSpacingScale: 1 },
    );
    expect(obstacle.x).toBe(0); // exempt body untouched
    expect(obstacle.z).toBe(0);
    expect(moved.has(1)).toBe(true);
    expect(dist(visible, obstacle)).toBeGreaterThanOrEqual(0.7 - 1e-3);
  });

  it('lets a tight doorway queue spread without leaving the corridor or exploding', () => {
    // Corridor / doorway: walkable only within |x| <= 0.5. Three bodies stacked along z must spread
    // along z (queue) while staying inside the corridor — no jitter blow-up, no wall push-through.
    const half = 0.5;
    const isWalkable = (x: number) => x >= -half && x <= half;
    const list = [agent(1, 0, 0), agent(2, 0.05, 0.3), agent(3, 0.02, 0.6)];
    resolveSeparation(list, allPairs(list), isWalkable, { iterations: 16, minSpacingScale: 1 });
    for (const a of list) {
      expect(Number.isFinite(a.x)).toBe(true);
      expect(Number.isFinite(a.z)).toBe(true);
      expect(a.x).toBeGreaterThanOrEqual(-half); // stayed in the corridor
      expect(a.x).toBeLessThanOrEqual(half);
      expect(Math.abs(a.z)).toBeLessThan(10); // bounded — no explosion
    }
    // Queue spread out along the corridor axis (min z-gap grew from the stacked 0.3).
    const zs = list.map((a) => a.z).sort((p, q) => p - q);
    expect(zs[1]! - zs[0]!).toBeGreaterThan(0.3);
    expect(zs[2]! - zs[1]!).toBeGreaterThan(0.3);
  });

  it('runs zero iterations as a no-op', () => {
    const a = agent(1, 0, 0);
    const b = agent(2, 0.1, 0);
    const list = [a, b];
    const moved = resolveSeparation(list, allPairs(list), ALWAYS_WALKABLE, {
      iterations: 0,
      minSpacingScale: 1,
    });
    expect(moved.size).toBe(0);
    expect(a.x).toBe(0);
    expect(b.x).toBe(0.1);
  });

  it('rejects invalid params (no silent fallback)', () => {
    const list = [agent(1, 0, 0)];
    expect(() =>
      resolveSeparation(list, allPairs(list), ALWAYS_WALKABLE, { iterations: -1, minSpacingScale: 1 }),
    ).toThrow(/iterations/);
    expect(() =>
      resolveSeparation(list, allPairs(list), ALWAYS_WALKABLE, { iterations: 2, minSpacingScale: 0 }),
    ).toThrow(/minSpacingScale/);
  });
});
