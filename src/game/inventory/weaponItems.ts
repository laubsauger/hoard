// T138 — map a carried WEAPON ITEM to its combat weapon CLASS. The combat system has four ballistic classes
// (pistol / shotgun / rifle / melee); the inventory holds specific weapon ITEMS. This decides which class an
// item arms, so weapon-swap can be gated to the classes the player actually CARRIES (find a shotgun → you can
// swap to it; you can't swap to a rifle you don't have). PURE; the class names equal the combat WeaponId union.

import { ITEM } from './catalog';
import type { ItemId } from '@/game/core/contracts';

/** Combat weapon class an item arms (equal to the combat `WeaponId` string union). */
export type WeaponClassName = 'pistol' | 'shotgun' | 'rifle' | 'melee';

/** The weapon CLASS a carried item arms, or null if the item is not a weapon. Pure + deterministic. */
export function weaponClassForItem(item: ItemId | number): WeaponClassName | null {
  switch (item as number) {
    case ITEM.Pistol:
      return 'pistol';
    case ITEM.Shotgun:
      return 'shotgun';
    case ITEM.HuntingRifle:
      return 'rifle';
    case ITEM.KitchenKnife:
    case ITEM.BaseballBat:
    case ITEM.Crowbar:
    case ITEM.FireAxe:
      return 'melee';
    default:
      return null;
  }
}
