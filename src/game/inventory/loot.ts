// T84 — loot tables + deterministic roller. Per-source weighted tables (kitchen, bathroom, garage, …,
// zombie corpse). Rolling is deterministic given an injected rng (V26 — seeded mulberry32 at the call
// site) so a world's loot replays identically. Item ids come from the T83 catalog. The placement of loot
// into actual world containers / corpses is the caller's job (scene build + T54 death) — this owns the
// CONTENT + the roll only.

import { ITEM } from './catalog';
import type { ItemId } from '@/game/core/contracts';

/** One weighted loot entry: probability `chance` (0..1) to drop `[min,max]` of `item`. */
export interface LootEntry {
  readonly item: number;
  readonly chance: number;
  readonly min: number;
  readonly max: number;
}

/** A rolled stack of items from a table. */
export interface LootStack {
  readonly item: ItemId;
  readonly count: number;
}

/** Loot source = the kind of container/body being searched. */
export type LootSource =
  | 'kitchen'
  | 'bathroom'
  | 'bedroom'
  | 'wardrobe'
  | 'garage'
  | 'toolshed'
  | 'gunCabinet'
  | 'corpse';

const TABLES: Record<LootSource, readonly LootEntry[]> = {
  kitchen: [
    { item: ITEM.CannedBeans, chance: 0.55, min: 1, max: 3 },
    { item: ITEM.Chips, chance: 0.45, min: 1, max: 2 },
    { item: ITEM.CandyBar, chance: 0.4, min: 1, max: 3 },
    { item: ITEM.WaterBottle, chance: 0.5, min: 1, max: 2 },
    { item: ITEM.KitchenKnife, chance: 0.25, min: 1, max: 1 },
    { item: ITEM.Battery, chance: 0.1, min: 1, max: 2 },
  ],
  bathroom: [
    { item: ITEM.Bandage, chance: 0.5, min: 1, max: 3 },
    { item: ITEM.Painkillers, chance: 0.35, min: 1, max: 2 },
    { item: ITEM.Antibiotics, chance: 0.15, min: 1, max: 1 },
  ],
  bedroom: [
    { item: ITEM.Flashlight, chance: 0.25, min: 1, max: 1 },
    { item: ITEM.Battery, chance: 0.3, min: 1, max: 3 },
    { item: ITEM.Jacket, chance: 0.2, min: 1, max: 1 },
    { item: ITEM.CandyBar, chance: 0.2, min: 1, max: 2 },
    { item: ITEM.Bandage, chance: 0.15, min: 1, max: 2 },
  ],
  wardrobe: [
    { item: ITEM.Backpack, chance: 0.3, min: 1, max: 1 },
    { item: ITEM.Jacket, chance: 0.45, min: 1, max: 1 },
    { item: ITEM.BaseballBat, chance: 0.15, min: 1, max: 1 },
  ],
  garage: [
    { item: ITEM.Hammer, chance: 0.4, min: 1, max: 1 },
    { item: ITEM.Screwdriver, chance: 0.4, min: 1, max: 1 },
    { item: ITEM.DuctTape, chance: 0.35, min: 1, max: 2 },
    { item: ITEM.Nails, chance: 0.5, min: 5, max: 40 },
    { item: ITEM.GasCan, chance: 0.2, min: 1, max: 1 },
    { item: ITEM.Crowbar, chance: 0.15, min: 1, max: 1 },
  ],
  toolshed: [
    { item: ITEM.Saw, chance: 0.45, min: 1, max: 1 },
    { item: ITEM.Hammer, chance: 0.45, min: 1, max: 1 },
    { item: ITEM.WoodPlank, chance: 0.5, min: 1, max: 6 },
    { item: ITEM.Nails, chance: 0.5, min: 5, max: 50 },
    { item: ITEM.FireAxe, chance: 0.12, min: 1, max: 1 },
    { item: ITEM.MetalSheet, chance: 0.18, min: 1, max: 2 },
  ],
  gunCabinet: [
    { item: ITEM.Pistol, chance: 0.4, min: 1, max: 1 },
    { item: ITEM.Shotgun, chance: 0.25, min: 1, max: 1 },
    { item: ITEM.HuntingRifle, chance: 0.2, min: 1, max: 1 },
    { item: ITEM.Ammo9mm, chance: 0.6, min: 6, max: 30 },
    { item: ITEM.ShotgunShells, chance: 0.5, min: 4, max: 16 },
    { item: ITEM.RifleRounds, chance: 0.4, min: 4, max: 16 },
  ],
  corpse: [
    { item: ITEM.Painkillers, chance: 0.12, min: 1, max: 1 },
    { item: ITEM.Bandage, chance: 0.12, min: 1, max: 2 },
    { item: ITEM.CandyBar, chance: 0.1, min: 1, max: 1 },
    { item: ITEM.Ammo9mm, chance: 0.1, min: 1, max: 8 },
    { item: ITEM.Battery, chance: 0.08, min: 1, max: 1 },
  ],
};

/**
 * Roll the loot for one source using an injected rng (0..1). Deterministic for a given rng sequence (V26).
 * Each entry rolls independently; a hit contributes `[min,max]` units.
 */
export function rollLoot(source: LootSource, rng: () => number): LootStack[] {
  const out: LootStack[] = [];
  for (const e of TABLES[source]) {
    if (rng() >= e.chance) continue;
    const span = e.max - e.min;
    const count = e.min + (span > 0 ? Math.floor(rng() * (span + 1)) : 0);
    if (count > 0) out.push({ item: e.item as ItemId, count });
  }
  return out;
}

/** All loot-source ids (for tests / content validation). */
export const LOOT_SOURCES = Object.keys(TABLES) as LootSource[];
