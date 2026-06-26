// T140 — equipment slots (Project-Zomboid-style belt/holster/back). The player has FOUR at-rest equipment
// slots, in hotbar key order (1..4): holster (pistol), back (long-gun), belt L + belt R (melee / tools). Each
// is a real single-item container (maxStacks 1, T140). Which slot is ACTIVE ("in hands") is a pointer the
// runtime tracks — the active slot's item drives `combat` (its weapon class), so the weapon physically stays
// on its belt and the hotbar keeps showing it (no separate hands container to empty on draw). PURE routing
// rules; the runtime owns the containers + active pointer + combat sync.

import { ITEM } from './catalog';
import { weaponClassForItem } from './weaponItems';
import type { ItemId } from '@/game/core/contracts';

/** The four at-rest equipment slots, in hotbar key order (1..4). */
export type EquipSlot = 'holster' | 'back' | 'beltL' | 'beltR';

/** Ordered slots = hotbar keys 1..4 (index 0 → key "1"). */
export const STORAGE_SLOTS: readonly EquipSlot[] = ['holster', 'back', 'beltL', 'beltR'];

/** Human labels for the paper-doll + hotbar UI. */
export const SLOT_LABELS: Readonly<Record<EquipSlot, string>> = {
  holster: 'Holster',
  back: 'Back',
  beltL: 'Belt L',
  beltR: 'Belt R',
};

/** Hand tools + throwables that can be carried on the belt (non-weapon-class items that still equip). */
const TOOL_ITEMS: ReadonlySet<number> = new Set<number>([ITEM.Hammer, ITEM.Saw, ITEM.Screwdriver, ITEM.Flashlight]);
/** Throwables — equip to the belt + LEFT-CLICK throws them at the cursor (no ballistics class). */
const THROWABLE_ITEMS: ReadonlySet<number> = new Set<number>([ITEM.Grenade, ITEM.Molotov]);

/** True when the item can be equipped at all — a weapon (any class), a hand tool, or a throwable. */
export function isEquippable(item: ItemId | number): boolean {
  return weaponClassForItem(item) !== null || TOOL_ITEMS.has(item as number) || THROWABLE_ITEMS.has(item as number);
}

/** True when the item is THROWN on left-click (a grenade), rather than fired. Pure. */
export function isThrowable(item: ItemId | number): boolean {
  return THROWABLE_ITEMS.has(item as number);
}

/**
 * The equipment slots that may hold the item, by weapon class / tool kind (in preference order):
 *  pistol → holster · shotgun|rifle → back · melee|tool → belt L then belt R.
 * Empty array = the item is not equippable. PURE + deterministic.
 */
export function slotsForItem(item: ItemId | number): EquipSlot[] {
  const cls = weaponClassForItem(item);
  if (cls === 'pistol') return ['holster'];
  if (cls === 'shotgun' || cls === 'rifle' || cls === 'smg') return ['back'];
  if (cls === 'melee') return ['beltL', 'beltR'];
  if (TOOL_ITEMS.has(item as number) || THROWABLE_ITEMS.has(item as number)) return ['beltL', 'beltR'];
  return [];
}

/** True when `slot` may hold `item` (category/class rule). */
export function slotAccepts(slot: EquipSlot, item: ItemId | number): boolean {
  return slotsForItem(item).includes(slot);
}

/** The canonical "home" slot for an item (its first preference), or null when not equippable. */
export function homeSlotForItem(item: ItemId | number): EquipSlot | null {
  return slotsForItem(item)[0] ?? null;
}
