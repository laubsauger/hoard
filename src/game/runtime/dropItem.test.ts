// T85 — drop to floor: an item dropped from the pack lands in a floor pile (a real lootable world container) at
// the player's cell, leaves the pack, accumulates on repeat drops, and the pile is pruned once fully picked back up.
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

/** The floor pile in the published inventory snapshot (a container labelled "Floor*"), or undefined. */
function floorView(rt: GameRuntime) {
  return rt.inventorySnapshot().find((v) => v.container.startsWith('Floor'));
}
/** Count of `item` on the floor (via the snapshot — no internal ref needed). */
function floorCount(rt: GameRuntime, item: number): number {
  return floorView(rt)?.slots.find((s) => s.item === item)?.count ?? 0;
}

describe('runtime drop to floor (T85)', () => {
  it('dropping removes the item from the pack into a floor pile at the player cell', () => {
    const rt = makeRuntime();
    const pack: ContainerRef = { entity: rt.playerEntity, container: 'player' };
    expect(rt.inventory.count(pack, ITEM.Bandage as ItemId)).toBe(2);

    expect(rt.dropItem(ITEM.Bandage)).toBe(true);
    expect(rt.inventory.count(pack, ITEM.Bandage as ItemId)).toBe(0); // whole stack left the pack
    expect(floorCount(rt, ITEM.Bandage)).toBe(2); // ...and landed on the floor
    expect(rt.floorPileMarkers().length).toBe(1); // a marker for the render lane
  });

  it('refuses to drop an item the pack does not hold', () => {
    const rt = makeRuntime();
    expect(rt.dropItem(ITEM.HuntingRifle)).toBe(false); // not carried
    expect(rt.floorPileMarkers().length).toBe(0); // no empty pile left behind
  });

  it('repeat drops on the same cell accumulate into one pile', () => {
    const rt = makeRuntime();
    rt.dropItem(ITEM.Bandage);
    rt.dropItem(ITEM.WaterBottle);
    expect(rt.floorPileMarkers().length).toBe(1); // one pile, two item types
    expect(floorCount(rt, ITEM.Bandage)).toBe(2);
    expect(floorCount(rt, ITEM.WaterBottle)).toBe(1);
  });

  it('picking everything back up prunes the pile', () => {
    const rt = makeRuntime();
    rt.dropItem(ITEM.Bandage);
    const label = floorView(rt)!.container;
    expect(rt.transferItem(label, 'player', ITEM.Bandage)).toBe(true); // loot it back
    expect(rt.floorPileMarkers().length).toBe(0); // emptied → pruned
    expect(floorView(rt)).toBeUndefined();
    const pack: ContainerRef = { entity: rt.playerEntity, container: 'player' };
    expect(rt.inventory.count(pack, ITEM.Bandage as ItemId)).toBe(2);
  });
});
