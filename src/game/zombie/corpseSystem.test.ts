// T54 / B9 / V18 — CorpseSystem: pooled, capped, lifetime-pruned corpse records that persist
// dismemberment (severed-region flags) and round-trip through the save-delta corpses category (V9).

import { describe, it, expect } from 'vitest';
import { CorpseSystem, resolveCorpseSettings } from './corpseSystem';
import type { CorpseSpawn } from './corpseSystem';

function spawn(over: Partial<CorpseSpawn> = {}): CorpseSpawn {
  return {
    entity: 1,
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
    archetype: 0,
    severedFlags: 0,
    bornTick: 0,
    ...over,
  };
}

describe('CorpseSystem (B9/T54)', () => {
  it('rejects a non-positive capacity / lifetime (V4 — no silent coercion)', () => {
    expect(() => new CorpseSystem({ capacity: 0, lifetimeTicks: 10 })).toThrow();
    expect(() => new CorpseSystem({ capacity: 4, lifetimeTicks: 0 })).toThrow();
  });

  it('records a corpse at the dead zombie state and exposes it in the live list', () => {
    const sys = new CorpseSystem({ capacity: 8, lifetimeTicks: 100 });
    sys.spawn(spawn({ entity: 42, x: 3, y: 0, z: -7, heading: 1.2, archetype: 2, severedFlags: 0b101, bornTick: 5 }));
    expect(sys.count).toBe(1);
    const c = sys.list[0]!;
    expect(c.entity).toBe(42);
    expect(c.x).toBe(3);
    expect(c.z).toBe(-7);
    expect(c.heading).toBeCloseTo(1.2, 6);
    expect(c.archetype).toBe(2);
    expect(c.severedFlags).toBe(0b101);
    expect(c.bornTick).toBe(5);
  });

  it('caps at capacity and recycles the OLDEST corpse when full', () => {
    const sys = new CorpseSystem({ capacity: 3, lifetimeTicks: 1000 });
    for (let i = 0; i < 3; i++) sys.spawn(spawn({ entity: i, bornTick: i }));
    expect(sys.count).toBe(3);
    expect(sys.list.map((c) => c.entity)).toEqual([0, 1, 2]);

    sys.spawn(spawn({ entity: 99, bornTick: 3 })); // over cap -> drop the oldest (entity 0)
    expect(sys.count).toBe(3);
    expect(sys.list.map((c) => c.entity)).toEqual([1, 2, 99]);
  });

  it('prunes corpses older than the configured lifetime (uniform-lifetime prefix)', () => {
    const sys = new CorpseSystem({ capacity: 8, lifetimeTicks: 100 });
    sys.spawn(spawn({ entity: 1, bornTick: 0 }));
    sys.spawn(spawn({ entity: 2, bornTick: 40 }));
    sys.spawn(spawn({ entity: 3, bornTick: 90 }));

    expect(sys.prune(99)).toBe(0); // none have reached lifetime yet
    expect(sys.count).toBe(3);

    // age >= lifetime expires: at tick 140 -> entity 1 (age 140) + entity 2 (age 100) expire; entity 3 (age 50) keeps.
    expect(sys.prune(140)).toBe(2);
    expect(sys.list.map((c) => c.entity)).toEqual([3]);
  });

  it('captures + restores through persistence records carrying severed-region flags (V9)', () => {
    const sys = new CorpseSystem({ capacity: 8, lifetimeTicks: 100 });
    sys.spawn(spawn({ entity: 7, x: 1, y: 0, z: 2, heading: 0.5, archetype: 1, severedFlags: 0b11000000, bornTick: 12 }));
    const records = sys.capture();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ entity: 7, x: 1, z: 2, atTick: 12, heading: 0.5, archetype: 1, severedFlags: 0b11000000 });

    const restored = new CorpseSystem({ capacity: 8, lifetimeTicks: 100 });
    restored.restore(records);
    expect(restored.count).toBe(1);
    expect(restored.list[0]).toMatchObject({ entity: 7, x: 1, z: 2, heading: 0.5, archetype: 1, severedFlags: 0b11000000, bornTick: 12 });
  });

  it('defaults the additive fields when restoring an older corpse record (V23/V4)', () => {
    const sys = new CorpseSystem({ capacity: 8, lifetimeTicks: 100 });
    // a record authored before corpses carried a body shape: only entity/x/z/atTick.
    sys.restore([{ entity: 5, x: 9, z: 4, atTick: 3 }]);
    expect(sys.count).toBe(1);
    expect(sys.list[0]).toMatchObject({ entity: 5, x: 9, z: 4, heading: 0, archetype: 0, severedFlags: 0, bornTick: 3 });
  });

  it('resolves a positive, integer pool capacity + lifetime from config (V4)', () => {
    const s = resolveCorpseSettings('desktop-high');
    expect(Number.isInteger(s.capacity)).toBe(true);
    expect(s.capacity).toBeGreaterThan(0);
    expect(Number.isInteger(s.lifetimeTicks)).toBe(true);
    expect(s.lifetimeTicks).toBeGreaterThan(0);
  });
});
