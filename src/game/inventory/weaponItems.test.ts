// T138 — weapon ITEM → combat CLASS map.
import { describe, it, expect } from 'vitest';
import { weaponClassForItem } from './weaponItems';
import { ITEM } from './catalog';

describe('weaponClassForItem (T138)', () => {
  it('maps firearms + melee items to their combat class; non-weapons → null', () => {
    expect(weaponClassForItem(ITEM.Pistol)).toBe('pistol');
    expect(weaponClassForItem(ITEM.Shotgun)).toBe('shotgun');
    expect(weaponClassForItem(ITEM.HuntingRifle)).toBe('rifle');
    expect(weaponClassForItem(ITEM.KitchenKnife)).toBe('melee');
    expect(weaponClassForItem(ITEM.BaseballBat)).toBe('melee');
    expect(weaponClassForItem(ITEM.Crowbar)).toBe('melee');
    expect(weaponClassForItem(ITEM.FireAxe)).toBe('melee');
    expect(weaponClassForItem(ITEM.Bandage)).toBeNull();
    expect(weaponClassForItem(ITEM.WaterBottle)).toBeNull();
    expect(weaponClassForItem(ITEM.Hammer)).toBeNull(); // a tool, not a weapon class
  });
});
