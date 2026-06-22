// T8 tests — SoA store: free-list reuse, alive iteration, typed accessors, capacity guard (V3/V26).

import { describe, it, expect } from 'vitest';
import { SimulationZombies, ZombieState } from './zombieStore';

function mk(capacity = 8): SimulationZombies {
  return new SimulationZombies(capacity);
}

describe('SimulationZombies SoA store (T8)', () => {
  it('spawns into ascending slots and tracks count/free', () => {
    const z = mk(4);
    expect(z.capacity).toBe(4);
    expect(z.count).toBe(0);
    const a = z.spawn({ archetype: 1, position: [1, 0, 2], health: 100 });
    const b = z.spawn({ archetype: 2, position: [3, 0, 4], health: 80 });
    expect(a).toBe(0);
    expect(b).toBe(1);
    expect(z.count).toBe(2);
    expect(z.freeCount).toBe(2);
  });

  it('reuses a freed slot (free-list reuse)', () => {
    const z = mk(4);
    const a = z.spawn({ archetype: 1, position: [0, 0, 0], health: 100 });
    z.spawn({ archetype: 2, position: [0, 0, 0], health: 100 });
    z.free(a);
    expect(z.isAlive(a)).toBe(false);
    const reused = z.spawn({ archetype: 9, position: [5, 6, 7], health: 50 });
    expect(reused).toBe(a); // same physical slot reused
    expect(z.isAlive(reused)).toBe(true);
    // reused slot is clean (no stale data from the previous occupant)
    expect(z.getArchetype(reused)).toBe(9);
    expect(z.getPosition(reused)).toEqual([5, 6, 7]);
  });

  it('throws when capacity is exhausted (no silent fallback)', () => {
    const z = mk(2);
    z.spawn({ archetype: 1, position: [0, 0, 0], health: 1 });
    z.spawn({ archetype: 1, position: [0, 0, 0], health: 1 });
    expect(() => z.spawn({ archetype: 1, position: [0, 0, 0], health: 1 })).toThrow(/exhausted/);
  });

  it('iterates only alive slots after frees', () => {
    const z = mk(8);
    const slots = [0, 1, 2, 3].map((i) => z.spawn({ archetype: i, position: [i, 0, 0], health: 100 }));
    z.free(slots[1]!);
    z.free(slots[3]!);
    const seen: number[] = [];
    z.forEachAlive((s) => seen.push(s));
    expect(seen).toEqual([0, 2]);
    expect([...z.aliveSlots()]).toEqual([0, 2]);
  });

  it('round-trips every typed field accessor', () => {
    const z = mk(2);
    const s = z.spawn({ archetype: 3, position: [0, 0, 0], health: 100, state: ZombieState.Wander });
    z.setPosition(s, 1.5, 2.5, 3.5);
    z.setVelocity(s, -1, 0, 2);
    z.setHeading(s, 1.25);
    z.setHealth(s, 42);
    z.setAnatomyFlags(s, 0b1010);
    z.setTarget(s, 7);
    z.setStimulus(s, 9);
    z.setChunk(s, 11);
    z.setSpatialCell(s, 13);
    z.setNavGroup(s, 5);
    z.setSimTier(s, 1);
    z.setRenderTier(s, 2);
    z.setAnimState(s, 4);
    z.setAnimPhase(s, 0.5);
    z.setStateTimer(s, 3.5);
    expect(z.getPosition(s)).toEqual([1.5, 2.5, 3.5]);
    expect(z.getVelocity(s)).toEqual([-1, 0, 2]);
    expect(z.getHeading(s)).toBeCloseTo(1.25);
    expect(z.getHealth(s)).toBe(42);
    expect(z.getAnatomyFlags(s)).toBe(0b1010);
    expect(z.getTarget(s)).toBe(7);
    expect(z.getStimulus(s)).toBe(9);
    expect(z.getChunk(s)).toBe(11);
    expect(z.getSpatialCell(s)).toBe(13);
    expect(z.getNavGroup(s)).toBe(5);
    expect(z.getSimTier(s)).toBe(1);
    expect(z.getRenderTier(s)).toBe(2);
    expect(z.getAnimState(s)).toBe(4);
    expect(z.getAnimPhase(s)).toBeCloseTo(0.5);
    expect(z.getStateTimer(s)).toBeCloseTo(3.5);
  });

  it('SimulationZombie view reads + writes the same authority', () => {
    const z = mk(2);
    const s = z.spawn({ archetype: 1, position: [1, 2, 3], health: 100 });
    const view = z.view(s);
    expect(view.health).toBe(100);
    view.health = 55;
    expect(z.getHealth(s)).toBe(55); // mutating the view mutates the store
    expect(view.position()).toEqual([1, 2, 3]);
    view.setPosition(9, 9, 9);
    expect(z.getPosition(s)).toEqual([9, 9, 9]);
  });

  it('rejects out-of-range slots and double-free', () => {
    const z = mk(2);
    const s = z.spawn({ archetype: 1, position: [0, 0, 0], health: 1 });
    expect(() => z.getHealth(99)).toThrow(/out of range/);
    z.free(s);
    expect(() => z.free(s)).toThrow(/not alive/);
  });
});
