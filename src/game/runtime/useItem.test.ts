// T138 — runtime.useItem: consuming a food/water/medical item from the PLAYER inventory deducts one unit and
// applies its survival effect; a non-consumable (or an empty stack) is refused without mutating the inventory.
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

describe('runtime.useItem (T138 consumables)', () => {
  it('consumes a water bottle (the seeded loadout has one) and refuses a non-consumable', () => {
    const rt = makeRuntime();
    const ref: ContainerRef = { entity: rt.playerEntity, container: 'player' };
    expect(rt.inventory.count(ref, ITEM.WaterBottle as ItemId)).toBe(1);
    expect(rt.useItem(ITEM.WaterBottle)).toBe(true);
    expect(rt.inventory.count(ref, ITEM.WaterBottle as ItemId)).toBe(0);
    expect(rt.useItem(ITEM.WaterBottle)).toBe(false); // none left → refused

    // a weapon is not a consumable → refused, count untouched.
    expect(rt.inventory.count(ref, ITEM.KitchenKnife as ItemId)).toBe(1);
    expect(rt.useItem(ITEM.KitchenKnife)).toBe(false);
    expect(rt.inventory.count(ref, ITEM.KitchenKnife as ItemId)).toBe(1);
  });

  it('using a bandage consumes one of the two seeded', () => {
    const rt = makeRuntime();
    const ref: ContainerRef = { entity: rt.playerEntity, container: 'player' };
    expect(rt.inventory.count(ref, ITEM.Bandage as ItemId)).toBe(2);
    expect(rt.useItem(ITEM.Bandage)).toBe(true);
    expect(rt.inventory.count(ref, ITEM.Bandage as ItemId)).toBe(1);
  });
});
