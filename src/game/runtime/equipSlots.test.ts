// T140 — equipment slots wired into the runtime: the starter loadout is stowed on the belt + the pistol drawn;
// drawing a slot makes it the active weapon (drives combat); re-drawing the active slot disarms to bare hands;
// equipping is validated by class; and equipping/drawing never changes total carry weight (items just relocate
// among the player's own containers).
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { createPlayerViewStore, createMapViewStore } from '@/stores';
import { ITEM } from '@/game/inventory';

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

describe('runtime equipment slots (T140)', () => {
  it('starter loadout stows weapons on the belt and draws the pistol', () => {
    const rt = makeRuntime();
    expect(rt.equipSlotItem('holster')).toBe(ITEM.Pistol);
    expect(rt.equipSlotItem('back')).toBe(ITEM.Shotgun);
    expect(rt.equipSlotItem('beltL')).toBe(ITEM.KitchenKnife);
    expect(rt.activeSlot()).toBe('holster');
    expect(rt.equippedItem()).toBe(ITEM.Pistol);
    expect(rt.currentWeaponId()).toBe('pistol'); // hands drives the combat class
  });

  it('drawing a slot makes it the active weapon; re-drawing it disarms to bare hands', () => {
    const rt = makeRuntime();
    expect(rt.drawSlot('back')).toBe('back');
    expect(rt.currentWeaponId()).toBe('shotgun');
    expect(rt.currentWeaponScatter().pellets).toBeGreaterThan(1); // shotgun fan proves combat follows hands
    expect(rt.drawSlot('back')).toBeNull(); // toggle off → unarmed
    expect(rt.currentWeaponId()).toBe('melee');
    expect(rt.drawSlot('beltL')).toBe('beltL'); // knife → melee class
    expect(rt.currentWeaponId()).toBe('melee');
    expect(rt.equippedItem()).toBe(ITEM.KitchenKnife);
  });

  it('equipItem validates by weapon class and refuses an item the player does not carry', () => {
    const rt = makeRuntime();
    expect(rt.equipItem(ITEM.Pistol, 'beltL')).toBe(false); // a pistol does not belong on the belt
    expect(rt.equipItem(ITEM.HuntingRifle, 'back')).toBe(false); // not carried
    expect(rt.equipSlotItem('beltL')).toBe(ITEM.KitchenKnife); // unchanged
  });

  it('unequipSlot stows the active weapon back in the pack and disarms', () => {
    const rt = makeRuntime();
    expect(rt.unequipSlot('holster')).toBe(true); // holster was the active slot
    expect(rt.equipSlotItem('holster')).toBeNull();
    expect(rt.activeSlot()).toBeNull();
    expect(rt.currentWeaponId()).toBe('melee');
  });

  it('equipping/drawing never changes total carry weight (items relocate within the player)', () => {
    const rt = makeRuntime();
    const before = rt.inventory.carriedWeight(rt.playerEntity);
    rt.drawSlot('back');
    rt.unequipSlot('beltL');
    rt.equipItem(ITEM.KitchenKnife, 'beltR');
    const after = rt.inventory.carriedWeight(rt.playerEntity);
    expect(after).toBeCloseTo(before);
  });

  it('playerCarries sees items in the pack AND the belt slots (tool-gates count equipped tools) (T140)', () => {
    const rt = makeRuntime();
    // the starter loadout includes a flashlight (in the pack) → the beam gate is satisfied out of the box.
    expect(rt.playerCarries(ITEM.Flashlight)).toBe(true);
    // the hammer is in the pack; equip it onto the belt → still "carried" (boarding gate must not break).
    expect(rt.playerCarries(ITEM.Hammer)).toBe(true);
    expect(rt.equipItem(ITEM.Hammer, 'beltR')).toBe(true);
    expect(rt.equipSlotItem('beltR')).toBe(ITEM.Hammer);
    expect(rt.playerCarries(ITEM.Hammer)).toBe(true); // now on the belt, still carried
    // something not in the loadout is not carried.
    expect(rt.playerCarries(ITEM.GasCan)).toBe(false);
  });

  it('cycleWeapon walks the equipped weapon slots in order', () => {
    const rt = makeRuntime();
    expect(rt.currentWeaponId()).toBe('pistol'); // active holster
    rt.cycleWeapon(1); // holster → back
    expect(rt.currentWeaponId()).toBe('shotgun');
    rt.cycleWeapon(1); // back → beltL (knife = melee)
    expect(rt.currentWeaponId()).toBe('melee');
  });
});
