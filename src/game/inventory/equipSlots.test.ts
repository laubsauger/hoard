// T140 — equipment slot ROUTING rules (pure). Each weapon class maps to its belt slots; tools go on the belt;
// non-equippable items map to nothing.
import { describe, it, expect } from 'vitest';
import { ITEM } from './catalog';
import { slotsForItem, slotAccepts, isEquippable, homeSlotForItem, STORAGE_SLOTS } from './equipSlots';

describe('equip slot routing (T140)', () => {
  it('routes each weapon class to its slot(s)', () => {
    expect(slotsForItem(ITEM.Pistol)).toEqual(['holster']);
    expect(slotsForItem(ITEM.Shotgun)).toEqual(['back']);
    expect(slotsForItem(ITEM.HuntingRifle)).toEqual(['back']);
    expect(slotsForItem(ITEM.KitchenKnife)).toEqual(['beltL', 'beltR']);
    expect(slotsForItem(ITEM.FireAxe)).toEqual(['beltL', 'beltR']);
  });

  it('routes hand tools to the belt and leaves non-equippables unslotted', () => {
    expect(slotsForItem(ITEM.Hammer)).toEqual(['beltL', 'beltR']);
    expect(slotsForItem(ITEM.Flashlight)).toEqual(['beltL', 'beltR']);
    expect(slotsForItem(ITEM.Bandage)).toEqual([]); // medical: not equippable
    expect(slotsForItem(ITEM.Ammo9mm)).toEqual([]);
    expect(isEquippable(ITEM.Bandage)).toBe(false);
    expect(isEquippable(ITEM.Pistol)).toBe(true);
  });

  it('slotAccepts + homeSlot agree with the routing', () => {
    expect(slotAccepts('holster', ITEM.Pistol)).toBe(true);
    expect(slotAccepts('beltL', ITEM.Pistol)).toBe(false); // a pistol belongs in the holster, not the belt
    expect(slotAccepts('back', ITEM.Shotgun)).toBe(true);
    expect(homeSlotForItem(ITEM.KitchenKnife)).toBe('beltL');
    expect(homeSlotForItem(ITEM.Bandage)).toBeNull();
  });

  it('STORAGE_SLOTS is the four belt slots in hotbar order', () => {
    expect([...STORAGE_SLOTS]).toEqual(['holster', 'back', 'beltL', 'beltR']);
  });
});
