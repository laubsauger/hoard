// T24 — authored crafting CONTENT. Verifies the recipes register cleanly and validate/consume/produce as
// expected against a pack (the pure CraftingSystem path the runtime's craftRecipe wraps).

import { describe, it, expect } from 'vitest';
import { CraftingSystem } from './crafting';
import { registerCraftingContent, RECIPE, RECIPES } from './recipes';
import { ITEM } from '@/game/inventory';
import type { ItemCategory } from '@/game/inventory';

function system() {
  const s = new CraftingSystem();
  registerCraftingContent(s);
  return s;
}

const NO_TOOLS: ReadonlySet<ItemCategory> = new Set();
const TOOL: ReadonlySet<ItemCategory> = new Set<ItemCategory>(['tool']);

describe('crafting content (T24)', () => {
  it('registers every authored recipe', () => {
    const s = system();
    for (const r of RECIPES) expect(s.hasRecipe(r.id)).toBe(true);
  });

  it('crafts a molotov from a gas can + duct tape (no tool needed)', () => {
    const s = system();
    const available = new Map<number, number>([[ITEM.GasCan, 1], [ITEM.DuctTape, 1]]);
    const out = s.craft(RECIPE.Molotov, { available, tools: NO_TOOLS, skill: 0 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.produced).toEqual({ item: ITEM.Molotov, count: 3 });
    expect(out.consumed).toContainEqual({ item: ITEM.GasCan, count: 1 });
    expect(out.consumed).toContainEqual({ item: ITEM.DuctTape, count: 1 });
  });

  it('fails the molotov with an explicit reason when an input is missing (no silent partial)', () => {
    const s = system();
    const out = s.craft(RECIPE.Molotov, { available: new Map([[ITEM.GasCan, 1]]), tools: NO_TOOLS, skill: 0 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('missing-input');
  });

  it('the radio-part safety-net recipe requires a tool', () => {
    const s = system();
    const available = new Map<number, number>([[ITEM.MetalSheet, 1], [ITEM.DuctTape, 1], [ITEM.Battery, 1]]);
    expect(s.craft(RECIPE.RadioPart, { available, tools: NO_TOOLS, skill: 0 }).ok).toBe(false);
    const withTool = s.craft(RECIPE.RadioPart, { available, tools: TOOL, skill: 0 });
    expect(withTool.ok).toBe(true);
    if (!withTool.ok) return;
    expect(withTool.produced).toEqual({ item: ITEM.RadioPart, count: 1 });
  });
});
