// T83 — item content catalog. The authored items register + validate, ids are unique + stable.
import { describe, it, expect } from 'vitest';
import { buildDefaultCatalog, ITEM, ITEM_CONTENT_COUNT } from './catalog';

describe('item content catalog (T83)', () => {
  it('builds the full authored catalog (every def passes V4 validation)', () => {
    const cat = buildDefaultCatalog();
    expect(ITEM_CONTENT_COUNT).toBeGreaterThanOrEqual(25);
    // Every declared id resolves to a def with a name + category.
    for (const id of Object.values(ITEM)) {
      const def = cat.get(id as never);
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.weightKg).toBeGreaterThan(0);
    }
  });

  it('ids are unique', () => {
    const ids = Object.values(ITEM);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('non-stackable items have maxStack 1; stackable have >1', () => {
    const cat = buildDefaultCatalog();
    const knife = cat.get(ITEM.KitchenKnife as never); // non-stackable weapon
    const ammo = cat.get(ITEM.Ammo9mm as never); // stackable
    expect(knife.maxStack).toBe(1);
    expect(ammo.maxStack).toBeGreaterThan(1);
  });
});
