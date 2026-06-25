// T83 — authored item CONTENT. A real starter catalog of item definitions across every category, built
// on top of the validating ItemCatalog (T23). Stable numeric ids (persist across saves, V26). This is the
// content layer the loot tables (T84) + inventory UI (T62) draw from — without it the world has no items.

import { ItemCatalog, type ItemDef } from './items';
import type { ItemId } from '@/game/core/contracts';
import type { QualityTier } from '@/config/types';

/** Stable item ids — never renumber (saves reference these, V26). */
export const ITEM = {
  // melee weapons
  KitchenKnife: 1,
  BaseballBat: 2,
  Crowbar: 3,
  FireAxe: 4,
  // firearms
  Pistol: 10,
  Shotgun: 11,
  HuntingRifle: 12,
  SMG: 13,
  Grenade: 14,
  // ammo
  Ammo9mm: 20,
  ShotgunShells: 21,
  RifleRounds: 22,
  // food + water
  CannedBeans: 30,
  Chips: 31,
  CandyBar: 32,
  WaterBottle: 33,
  // medical
  Bandage: 40,
  Antibiotics: 41,
  Painkillers: 42,
  Splint: 43,
  // tools
  Hammer: 50,
  Saw: 51,
  Screwdriver: 52,
  Flashlight: 53,
  // materials
  WoodPlank: 60,
  Nails: 61,
  MetalSheet: 62,
  DuctTape: 63,
  // fuel + misc
  GasCan: 70,
  Battery: 71,
  // clothing
  Backpack: 80,
  Jacket: 81,
} as const;

type ItemDefContent = Omit<ItemDef, 'id'> & { id: number };

const CONTENT: readonly ItemDefContent[] = [
  // melee
  { id: ITEM.KitchenKnife, name: 'Kitchen Knife', category: 'weapon', weightKg: 0.3, stackable: false },
  { id: ITEM.BaseballBat, name: 'Baseball Bat', category: 'weapon', weightKg: 1.0, stackable: false },
  { id: ITEM.Crowbar, name: 'Crowbar', category: 'weapon', weightKg: 1.5, stackable: false },
  { id: ITEM.FireAxe, name: 'Fire Axe', category: 'weapon', weightKg: 3.0, stackable: false },
  // firearms
  { id: ITEM.Pistol, name: 'Pistol', category: 'weapon', weightKg: 1.1, stackable: false },
  { id: ITEM.Shotgun, name: 'Shotgun', category: 'weapon', weightKg: 3.4, stackable: false },
  { id: ITEM.HuntingRifle, name: 'Hunting Rifle', category: 'weapon', weightKg: 3.9, stackable: false },
  { id: ITEM.SMG, name: 'SMG', category: 'weapon', weightKg: 2.6, stackable: false },
  { id: ITEM.Grenade, name: 'Hand Grenade', category: 'weapon', weightKg: 0.4, stackable: true, maxStack: 6 },
  // ammo
  { id: ITEM.Ammo9mm, name: '9mm Rounds', category: 'ammo', weightKg: 0.01, stackable: true, maxStack: 60 },
  { id: ITEM.ShotgunShells, name: 'Shotgun Shells', category: 'ammo', weightKg: 0.05, stackable: true, maxStack: 40 },
  { id: ITEM.RifleRounds, name: 'Rifle Rounds', category: 'ammo', weightKg: 0.02, stackable: true, maxStack: 40 },
  // food + water
  { id: ITEM.CannedBeans, name: 'Canned Beans', category: 'food', weightKg: 0.4, stackable: true, maxStack: 12 },
  { id: ITEM.Chips, name: 'Bag of Chips', category: 'food', weightKg: 0.1, stackable: true, maxStack: 12 },
  { id: ITEM.CandyBar, name: 'Candy Bar', category: 'food', weightKg: 0.05, stackable: true, maxStack: 24 },
  { id: ITEM.WaterBottle, name: 'Water Bottle', category: 'water', weightKg: 0.6, stackable: true, maxStack: 8 },
  // medical
  { id: ITEM.Bandage, name: 'Bandage', category: 'medical', weightKg: 0.05, stackable: true, maxStack: 20 },
  { id: ITEM.Antibiotics, name: 'Antibiotics', category: 'medical', weightKg: 0.05, stackable: true, maxStack: 10 },
  { id: ITEM.Painkillers, name: 'Painkillers', category: 'medical', weightKg: 0.05, stackable: true, maxStack: 10 },
  { id: ITEM.Splint, name: 'Splint', category: 'medical', weightKg: 0.3, stackable: false },
  // tools
  { id: ITEM.Hammer, name: 'Hammer', category: 'tool', weightKg: 0.6, stackable: false },
  { id: ITEM.Saw, name: 'Saw', category: 'tool', weightKg: 0.8, stackable: false },
  { id: ITEM.Screwdriver, name: 'Screwdriver', category: 'tool', weightKg: 0.2, stackable: false },
  { id: ITEM.Flashlight, name: 'Flashlight', category: 'tool', weightKg: 0.3, stackable: false },
  // materials
  { id: ITEM.WoodPlank, name: 'Wood Plank', category: 'material', weightKg: 1.2, stackable: true, maxStack: 20 },
  { id: ITEM.Nails, name: 'Nails', category: 'material', weightKg: 0.01, stackable: true, maxStack: 100 },
  { id: ITEM.MetalSheet, name: 'Metal Sheet', category: 'material', weightKg: 2.5, stackable: true, maxStack: 10 },
  { id: ITEM.DuctTape, name: 'Duct Tape', category: 'material', weightKg: 0.2, stackable: true, maxStack: 6 },
  // fuel + misc
  { id: ITEM.GasCan, name: 'Gas Can', category: 'fuel', weightKg: 4.0, stackable: false },
  { id: ITEM.Battery, name: 'Battery', category: 'misc', weightKg: 0.4, stackable: true, maxStack: 12 },
  // clothing
  { id: ITEM.Backpack, name: 'Backpack', category: 'clothing', weightKg: 1.0, stackable: false },
  { id: ITEM.Jacket, name: 'Jacket', category: 'clothing', weightKg: 1.2, stackable: false },
];

/** Build the catalog populated with the full authored item content (T83). Validated at registration (V4). */
export function buildDefaultCatalog(tier?: QualityTier): ItemCatalog {
  const catalog = new ItemCatalog(tier);
  for (const c of CONTENT) catalog.define({ ...c, id: c.id as ItemId });
  return catalog;
}

/** Number of authored item definitions (for tests / diagnostics). */
export const ITEM_CONTENT_COUNT = CONTENT.length;
