// T84 — loot tables + roller. Deterministic, valid items, sparse corpses.
import { describe, it, expect } from 'vitest';
import { rollLoot, LOOT_SOURCES } from './loot';
import { buildDefaultCatalog } from './catalog';

/** Seeded PRNG (mirrors the runtime's mulberry32) so a roll replays identically (V26). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('loot tables (T84/V26)', () => {
  it('is deterministic for a given seed', () => {
    const a = rollLoot('garage', mulberry32(99));
    const b = rollLoot('garage', mulberry32(99));
    expect(a).toEqual(b);
  });

  it('only rolls items that exist in the catalog (V4)', () => {
    const cat = buildDefaultCatalog();
    for (const src of LOOT_SOURCES) {
      // Roll many times to exercise most entries.
      for (let s = 0; s < 40; s++) {
        for (const stack of rollLoot(src, mulberry32(s * 7 + 1))) {
          expect(() => cat.get(stack.item)).not.toThrow();
          expect(stack.count).toBeGreaterThan(0);
        }
      }
    }
  });

  it('corpses are sparse (often empty), kitchens usually drop something', () => {
    let corpseEmpty = 0;
    let kitchenNonEmpty = 0;
    for (let s = 0; s < 60; s++) {
      if (rollLoot('corpse', mulberry32(s * 13 + 3)).length === 0) corpseEmpty += 1;
      if (rollLoot('kitchen', mulberry32(s * 17 + 5)).length > 0) kitchenNonEmpty += 1;
    }
    expect(corpseEmpty).toBeGreaterThan(20); // corpses mostly empty
    expect(kitchenNonEmpty).toBeGreaterThan(40); // kitchens usually have food
  });
});
