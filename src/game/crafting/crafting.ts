// T24 — crafting. Two paths:
//  1. CONTEXTUAL common-sense: a tool + material + skill + target object yields obvious actions
//     (cut rope with a knife, board a window with planks+hammer). Cheap, no recipe authoring.
//  2. RECIPES: reserved for NON-obvious/specialist work (chemistry/medicine/fabrication). Validated
//     against available inputs + tool + skill; fails with an explicit reason (never silent).
// Repairs reuse the SAME material+tool logic as destruction (strength restored per material unit,
// scaled by whether the right tool is present) so repair and damage stay symmetric.
// The system is PURE: it reports what to consume/produce; the caller applies it via inventory
// commands (V1 — crafting never mutates containers directly).

import { resolveDomain } from '@/config/registry';
import { craftingConfig } from '@/config/domains/crafting';
import type { QualityTier, ResolvedDomain } from '@/config/types';
import type { ItemId } from '@/game/core/contracts';
import type { ItemCategory } from '@/game/inventory/items';

export type CraftingSettings = ResolvedDomain<typeof craftingConfig>;

const REFERENCE_TIER: QualityTier = 'desktop-high';

function assertSkill(skill: number): void {
  if (Number.isNaN(skill) || skill < 0 || skill > 1) throw new Error(`skill must be in [0,1], got ${skill}`);
}

/** A contextual common-sense action enabled by what the player currently has + faces. */
export interface ContextualRule {
  readonly id: string;
  readonly action: string;
  /** Required tool category (omit -> none / bare hands). */
  readonly tool?: ItemCategory;
  /** Required material category (omit -> none). */
  readonly material?: ItemCategory;
  /** Required target object kind (omit -> any). */
  readonly target?: string;
  /** Minimum skill 0..1. */
  readonly minSkill?: number;
}

export interface CraftContext {
  readonly tools: ReadonlySet<ItemCategory>;
  readonly materials: ReadonlySet<ItemCategory>;
  readonly skill: number;
  readonly target?: string;
}

export interface ContextualAction {
  readonly id: string;
  readonly action: string;
  readonly seconds: number;
}

export interface ItemStack {
  readonly item: ItemId;
  readonly count: number;
}

/** An explicit recipe for non-obvious/specialist output. */
export interface Recipe {
  readonly id: string;
  readonly inputs: readonly ItemStack[];
  readonly tool?: ItemCategory;
  readonly minSkill: number;
  readonly output: ItemStack;
  /** Base craft time at zero skill. */
  readonly seconds: number;
  readonly discipline: 'chemistry' | 'medicine' | 'fabrication' | 'specialist';
}

export interface CraftRequest {
  /** Available counts keyed by item id. */
  readonly available: ReadonlyMap<number, number>;
  readonly tools: ReadonlySet<ItemCategory>;
  readonly skill: number;
}

export type CraftOutcome =
  | { readonly ok: true; readonly consumed: readonly ItemStack[]; readonly produced: ItemStack; readonly seconds: number }
  | { readonly ok: false; readonly reason: string };

export interface RepairRequest {
  /** Structural strength currently missing on the target. */
  readonly missingStrength: number;
  /** Units of repair material applied. */
  readonly materialUnits: number;
  readonly hasTool: boolean;
  readonly skill: number;
}

export interface RepairOutcome {
  readonly strengthRestored: number;
  readonly seconds: number;
}

export class CraftingSystem {
  readonly settings: CraftingSettings;
  private readonly rules: ContextualRule[] = [];
  private readonly recipes = new Map<string, Recipe>();

  constructor(tier: QualityTier = REFERENCE_TIER) {
    this.settings = resolveDomain(craftingConfig, tier);
  }

  addRule(rule: ContextualRule): void {
    if (rule.minSkill !== undefined) assertSkill(rule.minSkill);
    this.rules.push(rule);
  }

  addRecipe(recipe: Recipe): void {
    assertSkill(recipe.minSkill);
    if (recipe.seconds < 0 || Number.isNaN(recipe.seconds)) throw new Error(`recipe '${recipe.id}' seconds must be >= 0`);
    if (recipe.output.count <= 0) throw new Error(`recipe '${recipe.id}' output count must be > 0`);
    if (this.recipes.has(recipe.id)) throw new Error(`recipe '${recipe.id}' already defined`);
    this.recipes.set(recipe.id, recipe);
  }

  /** Skill shortens craft time (competence = speed/reliability, V31), never below the floor. */
  private craftSeconds(base: number, skill: number): number {
    return base * (1 - skill * this.settings.skillTimeReductionMax);
  }

  /** Common-sense actions enabled by the current context. */
  availableActions(ctx: CraftContext): ContextualAction[] {
    assertSkill(ctx.skill);
    const out: ContextualAction[] = [];
    for (const r of this.rules) {
      if (r.tool && !ctx.tools.has(r.tool)) continue;
      if (r.material && !ctx.materials.has(r.material)) continue;
      if (r.target !== undefined && r.target !== ctx.target) continue;
      if (r.minSkill !== undefined && ctx.skill < r.minSkill) continue;
      out.push({ id: r.id, action: r.action, seconds: this.craftSeconds(this.settings.baseCraftSeconds, ctx.skill) });
    }
    return out;
  }

  hasRecipe(id: string): boolean {
    return this.recipes.has(id);
  }

  /** Validate + resolve a recipe. Fails with an explicit reason; never partially consumes. */
  craft(recipeId: string, req: CraftRequest): CraftOutcome {
    assertSkill(req.skill);
    const recipe = this.recipes.get(recipeId);
    if (!recipe) return { ok: false, reason: 'unknown-recipe' };
    if (req.skill < recipe.minSkill) return { ok: false, reason: 'insufficient-skill' };
    if (recipe.tool && !req.tools.has(recipe.tool)) return { ok: false, reason: 'missing-tool' };
    for (const input of recipe.inputs) {
      if ((req.available.get(input.item as number) ?? 0) < input.count) return { ok: false, reason: 'missing-input' };
    }
    return {
      ok: true,
      consumed: recipe.inputs.map((i) => ({ ...i })),
      produced: { ...recipe.output },
      seconds: this.craftSeconds(recipe.seconds, req.skill),
    };
  }

  /**
   * Repair: strength restored = material units * per-unit strength * tool efficiency, capped at the
   * missing strength. Same shape as destruction's reinforce (material + tool drive the magnitude).
   */
  repair(req: RepairRequest): RepairOutcome {
    assertSkill(req.skill);
    if (req.missingStrength < 0) throw new Error(`missingStrength must be >= 0, got ${req.missingStrength}`);
    if (req.materialUnits < 0) throw new Error(`materialUnits must be >= 0, got ${req.materialUnits}`);
    const efficiency = req.hasTool ? this.settings.repairToolEfficiency : this.settings.repairBareHandsEfficiency;
    const raw = req.materialUnits * this.settings.repairStrengthPerMaterial * efficiency;
    const strengthRestored = Math.min(raw, req.missingStrength);
    return {
      strengthRestored,
      seconds: this.craftSeconds(this.settings.baseCraftSeconds, req.skill),
    };
  }
}
