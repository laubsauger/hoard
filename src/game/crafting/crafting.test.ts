// T24 tests — contextual common-sense actions surface from tool+material+skill+target; recipes
// (non-obvious) validate inputs/tool/skill and fail with an explicit reason; skill shortens time
// (competence = reliability/speed, V31); repair reuses the destruction material+tool logic.

import { describe, it, expect } from 'vitest';
import { CraftingSystem } from './crafting';
import type { ItemId } from '@/game/core/contracts';
import type { ItemCategory } from '@/game/inventory/items';

function tools(...c: ItemCategory[]): ReadonlySet<ItemCategory> { return new Set(c); }

function withRules(): CraftingSystem {
  const c = new CraftingSystem();
  c.addRule({ id: 'board-window', action: 'board', tool: 'tool', material: 'material', target: 'window' });
  c.addRule({ id: 'cut-cloth', action: 'cut', tool: 'tool', material: 'material' });
  c.addRule({ id: 'force-lock', action: 'pry', tool: 'tool', target: 'door', minSkill: 0.5 });
  return c;
}

describe('crafting — contextual common-sense', () => {
  it('surfaces actions whose tool+material+target+skill are all satisfied', () => {
    const c = withRules();
    const actions = c.availableActions({ tools: tools('tool'), materials: new Set<ItemCategory>(['material']), skill: 0.2, target: 'window' });
    const ids = actions.map((a) => a.id);
    expect(ids).toContain('board-window');
    expect(ids).toContain('cut-cloth');
    expect(ids).not.toContain('force-lock'); // wrong target + below skill
  });

  it('hides an action when its skill requirement is unmet', () => {
    const c = withRules();
    const low = c.availableActions({ tools: tools('tool'), materials: new Set<ItemCategory>(), skill: 0.2, target: 'door' });
    const high = c.availableActions({ tools: tools('tool'), materials: new Set<ItemCategory>(), skill: 0.9, target: 'door' });
    expect(low.map((a) => a.id)).not.toContain('force-lock');
    expect(high.map((a) => a.id)).toContain('force-lock');
  });

  it('higher skill shortens the action time', () => {
    const c = withRules();
    const slow = c.availableActions({ tools: tools('tool'), materials: new Set<ItemCategory>(['material']), skill: 0, target: 'window' })[0]!;
    const fast = c.availableActions({ tools: tools('tool'), materials: new Set<ItemCategory>(['material']), skill: 1, target: 'window' })[0]!;
    expect(fast.seconds).toBeLessThan(slow.seconds);
  });
});

describe('crafting — recipes (non-obvious)', () => {
  function withRecipe(): { c: CraftingSystem; alcohol: ItemId; cloth: ItemId; molotov: ItemId } {
    const c = new CraftingSystem();
    const alcohol = 20 as ItemId;
    const cloth = 21 as ItemId;
    const molotov = 22 as ItemId;
    c.addRecipe({
      id: 'molotov',
      inputs: [{ item: alcohol, count: 1 }, { item: cloth, count: 1 }],
      tool: 'tool',
      minSkill: 0.3,
      output: { item: molotov, count: 1 },
      seconds: 6,
      discipline: 'chemistry',
    });
    return { c, alcohol, cloth, molotov };
  }

  it('crafts when inputs + tool + skill are satisfied; scales time by skill', () => {
    const { c, alcohol, cloth, molotov } = withRecipe();
    const available = new Map<number, number>([[alcohol as number, 2], [cloth as number, 1]]);
    const out = c.craft('molotov', { available, tools: tools('tool'), skill: 1 });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.produced.item).toBe(molotov);
      expect(out.consumed).toHaveLength(2);
      expect(out.seconds).toBeLessThan(6); // skill reduced time
    }
  });

  it('fails with an explicit reason for each missing precondition', () => {
    const { c, alcohol, cloth } = withRecipe();
    const full = new Map<number, number>([[alcohol as number, 1], [cloth as number, 1]]);
    const missing = new Map<number, number>([[alcohol as number, 1]]);

    const noTool = c.craft('molotov', { available: full, tools: tools(), skill: 1 });
    expect(noTool.ok).toBe(false);
    if (!noTool.ok) expect(noTool.reason).toBe('missing-tool');

    const lowSkill = c.craft('molotov', { available: full, tools: tools('tool'), skill: 0.1 });
    if (!lowSkill.ok) expect(lowSkill.reason).toBe('insufficient-skill');

    const noInput = c.craft('molotov', { available: missing, tools: tools('tool'), skill: 1 });
    if (!noInput.ok) expect(noInput.reason).toBe('missing-input');

    const unknown = c.craft('nope', { available: full, tools: tools('tool'), skill: 1 });
    if (!unknown.ok) expect(unknown.reason).toBe('unknown-recipe');
  });
});

describe('crafting — repair reuses destruction material+tool logic', () => {
  it('a tool repairs more effectively than bare hands, capped at the missing strength', () => {
    const c = new CraftingSystem();
    const withTool = c.repair({ missingStrength: 1000, materialUnits: 2, hasTool: true, skill: 0 });
    const bare = c.repair({ missingStrength: 1000, materialUnits: 2, hasTool: false, skill: 0 });
    expect(withTool.strengthRestored).toBeGreaterThan(bare.strengthRestored);

    const capped = c.repair({ missingStrength: 10, materialUnits: 100, hasTool: true, skill: 0 });
    expect(capped.strengthRestored).toBe(10); // never over-repairs
  });
});
