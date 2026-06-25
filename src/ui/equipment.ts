// T140 — shared UI helpers for the equipment paper-doll + hotbar. Item-name/category lookups from the T83
// catalog, and a projection of the inventory-view containers into the four ordered equipment slots
// (holster/back/belt L/belt R). Pure read helpers — no store mutation (V1/V11).

import { buildDefaultCatalog, STORAGE_SLOTS, SLOT_LABELS, type EquipSlot } from '../game/inventory';
import type { ContainerView } from '../stores/inventoryView';

const CATALOG = buildDefaultCatalog();

export function itemName(id: number): string {
  try {
    return CATALOG.get(id as never).name;
  } catch {
    return `#${id}`;
  }
}

export function itemCategory(id: number): string {
  try {
    return CATALOG.get(id as never).category;
  } catch {
    return 'misc';
  }
}

/** One equipment slot projected for the UI: its key, label, the item it holds (or null), and whether it's the
 *  ACTIVE ("in hands") slot. */
export interface EquipSlotView {
  readonly slot: EquipSlot;
  readonly label: string;
  readonly item: number | null;
  readonly active: boolean;
}

/** Project the inventory-view containers into the four ordered equipment slots (hotbar keys 1..4). */
export function equipSlotViews(containers: readonly ContainerView[]): EquipSlotView[] {
  return STORAGE_SLOTS.map((slot) => {
    const c = containers.find((cv) => cv.container === slot);
    return {
      slot,
      label: SLOT_LABELS[slot],
      item: c?.slots[0]?.item ?? null,
      active: c?.active ?? false,
    };
  });
}

/** The item currently in hands (the active slot's item), or null when unarmed. */
export function activeEquippedItem(containers: readonly ContainerView[]): number | null {
  const active = containers.find((c) => c.equipSlot && c.active);
  return active?.slots[0]?.item ?? null;
}
