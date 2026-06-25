// T139 — a worn backpack raises the player's carry capacity; removing it restores the base (refused overloaded).
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { createPlayerViewStore, createMapViewStore } from '@/stores';
import { ITEM } from '@/game/inventory';
import type { ContainerRef, ItemId } from '@/game/core/contracts';

const TIER = 'desktop-high' as const;

function makeRuntime(): GameRuntime {
  return new GameRuntime({
    tier: TIER,
    adapter: new InMemoryPersistenceAdapter(),
    scene: buildTestBlock(),
    playerStore: createPlayerViewStore(),
    mapStore: createMapViewStore(),
  });
}

describe('runtime backpack (T139)', () => {
  it('refuses to equip with no pack; equipping a carried pack raises capacity; removing restores it', () => {
    const rt = makeRuntime();
    const ref: ContainerRef = { entity: rt.playerEntity, container: 'player' };

    expect(rt.equipBackpack()).toBe(false); // none carried
    expect(rt.isBackpackEquipped()).toBe(false);

    // free space (drop the heavy planks) then pick up a backpack.
    rt.inventory.take(ref, ITEM.WoodPlank as ItemId, 6);
    rt.inventory.seed(ref, ITEM.Backpack as ItemId, 1);

    const baseCap = rt.inventory.capacityOf(ref);
    expect(rt.equipBackpack()).toBe(true);
    expect(rt.isBackpackEquipped()).toBe(true);
    expect(rt.inventory.capacityOf(ref)).toBeGreaterThan(baseCap); // capacity rose

    expect(rt.equipBackpack()).toBe(false); // already worn → no double-equip

    expect(rt.unequipBackpack()).toBe(true);
    expect(rt.isBackpackEquipped()).toBe(false);
    expect(rt.inventory.capacityOf(ref)).toBe(baseCap); // restored
  });
});
