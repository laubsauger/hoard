// T138 — CONSUMABLE effects. PURE map from an item to what CONSUMING one unit does to the survival state, or
// null when the item is not a consumable (a weapon/tool/material is never "used" this way). The runtime applies
// the returned delta (eat→hunger, drink→thirst, treat→treatWound) then deducts one unit. Headless-testable.

import { ITEM } from './catalog';
import type { ItemId } from '@/game/core/contracts';

export type ConsumeEffect =
  /** Reduce hunger by `amount` (0..1). */
  | { readonly kind: 'eat'; readonly amount: number }
  /** Reduce thirst by `amount` (0..1). */
  | { readonly kind: 'drink'; readonly amount: number }
  /** Apply wound treatment of `amount` effectiveness (clots bleeding, closes a wound, knocks back infection). */
  | { readonly kind: 'treat'; readonly amount: number };

/** The survival effect of CONSUMING one unit of `item`, or null if it isn't a consumable. Amounts are 0..1
 *  deltas the runtime applies via SurvivalSystem.eat/drink/treatWound. Pure + deterministic (V26). */
export function consumeEffect(item: ItemId | number): ConsumeEffect | null {
  switch (item as number) {
    // food — restores hunger by calorie density
    case ITEM.CannedBeans:
      return { kind: 'eat', amount: 0.35 };
    case ITEM.Chips:
      return { kind: 'eat', amount: 0.18 };
    case ITEM.CandyBar:
      return { kind: 'eat', amount: 0.14 };
    // water — restores thirst
    case ITEM.WaterBottle:
      return { kind: 'drink', amount: 0.45 };
    // medical — wound treatment (bleeding/wounds/infection)
    case ITEM.Bandage:
      return { kind: 'treat', amount: 0.6 };
    case ITEM.Splint:
      return { kind: 'treat', amount: 0.45 };
    case ITEM.Antibiotics:
      return { kind: 'treat', amount: 0.5 }; // infection-focused (treatWound knocks infection)
    case ITEM.Painkillers:
      return { kind: 'treat', amount: 0.25 };
    default:
      return null;
  }
}

/** True when an item can be USED (consumed) from the inventory — drives the "Use" action in the inventory UI. */
export function isConsumable(item: ItemId | number): boolean {
  return consumeEffect(item) !== null;
}
