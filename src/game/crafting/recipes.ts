// T24 — authored CRAFTING content. The T24 CraftingSystem is a pure validator with no built-in recipes; this is
// the content layer that fills it (mirrors how catalog.ts fills the ItemCatalog). RECIPES are the non-obvious /
// specialist outputs (fabrication / medicine) the player assembles from carried inputs + a tool; the contextual
// common-sense path (cut/board/pry) stays with the interaction wheel. Every recipe is minSkill 0 for now — the
// player skill stat is a future system, so nothing is gated behind it yet (V4: explicit, no invented skill).

import { ITEM } from '@/game/inventory';
import type { ItemId } from '@/game/core/contracts';
import type { CraftingSystem, Recipe } from './crafting';

/** Stable recipe ids — referenced by the craft command from the UI (V1). */
export const RECIPE = {
  Molotov: 'craft.molotov',
  Bandage: 'craft.bandage',
  RadioPart: 'craft.radioPart',
} as const;

/** Item ids are a branded type; the authored ITEM constants are plain numbers — this casts at the content seam. */
const stack = (item: number, count: number): { item: ItemId; count: number } => ({ item: item as ItemId, count });

export const RECIPES: readonly Recipe[] = [
  // A gas can + a rag → three firebombs. The single most useful crafted item for route denial (T146 fire).
  {
    id: RECIPE.Molotov,
    inputs: [stack(ITEM.GasCan, 1), stack(ITEM.DuctTape, 1)],
    output: stack(ITEM.Molotov, 3),
    minSkill: 0,
    seconds: 4,
    discipline: 'fabrication',
  },
  // Tear a jacket into improvised bandages (no tool needed).
  {
    id: RECIPE.Bandage,
    inputs: [stack(ITEM.Jacket, 1)],
    output: stack(ITEM.Bandage, 4),
    minSkill: 0,
    seconds: 3,
    discipline: 'medicine',
  },
  // SAFETY-NET fabrication (T40): assemble a radio part from scrap + a tool, so the objective is solvable even if
  // loot RNG is unkind. Needs a tool (screwdriver/hammer = category 'tool').
  {
    id: RECIPE.RadioPart,
    inputs: [stack(ITEM.MetalSheet, 1), stack(ITEM.DuctTape, 1), stack(ITEM.Battery, 1)],
    output: stack(ITEM.RadioPart, 1),
    tool: 'tool',
    minSkill: 0,
    seconds: 6,
    discipline: 'fabrication',
  },
];

/** Register all authored recipes into a CraftingSystem (called once at runtime init). Validated at add (V4). */
export function registerCraftingContent(system: CraftingSystem): void {
  for (const r of RECIPES) system.addRecipe(r);
}
