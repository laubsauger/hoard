// T23/T24 — item catalog. Item DEFINITIONS are content; the catalog validates them against the typed
// items-domain bounds at registration (V4 — invalid content is rejected, never silently coerced).

import { resolveDomain } from '@/config/registry';
import { itemsConfig } from '@/config/domains/items';
import type { QualityTier, ResolvedDomain } from '@/config/types';
import type { ItemId } from '@/game/core/contracts';

export type ItemsSettings = ResolvedDomain<typeof itemsConfig>;

const REFERENCE_TIER: QualityTier = 'desktop-high';

/** Coarse category for inventory rules + contextual crafting. */
export type ItemCategory =
  | 'weapon'
  | 'tool'
  | 'food'
  | 'water'
  | 'medical'
  | 'material'
  | 'ammo'
  | 'clothing'
  | 'fuel'
  | 'misc';

export interface ItemDef {
  readonly id: ItemId;
  readonly name: string;
  readonly category: ItemCategory;
  /** Per-unit weight in kg. */
  readonly weightKg: number;
  readonly stackable: boolean;
  /** Max units in a single stack. Omit -> items-domain default for stackable, 1 for non-stackable. */
  readonly maxStack?: number;
}

export class ItemCatalog {
  readonly settings: ItemsSettings;
  private readonly defs = new Map<number, ItemDef>();

  constructor(tier: QualityTier = REFERENCE_TIER) {
    this.settings = resolveDomain(itemsConfig, tier);
  }

  /** Register an item definition. Throws on out-of-bound content (V4). Returns the resolved def. */
  define(def: ItemDef): ItemDef {
    if (def.weightKg < 0 || Number.isNaN(def.weightKg)) {
      throw new Error(`item '${def.name}' weight must be >= 0, got ${def.weightKg}`);
    }
    if (def.weightKg > this.settings.maxItemWeightKg) {
      throw new Error(`item '${def.name}' weight ${def.weightKg}kg exceeds maxItemWeightKg ${this.settings.maxItemWeightKg}`);
    }
    const maxStack = def.maxStack ?? (def.stackable ? this.settings.defaultMaxStack : 1);
    if (!Number.isInteger(maxStack) || maxStack < 1) {
      throw new Error(`item '${def.name}' maxStack must be a positive integer, got ${maxStack}`);
    }
    if (!def.stackable && maxStack !== 1) {
      throw new Error(`non-stackable item '${def.name}' must have maxStack 1, got ${maxStack}`);
    }
    if (this.defs.has(def.id as number)) throw new Error(`item id ${def.id} already defined`);
    const resolved: ItemDef = { ...def, maxStack };
    this.defs.set(def.id as number, resolved);
    return resolved;
  }

  has(id: ItemId): boolean {
    return this.defs.has(id as number);
  }

  /** Look up a definition. Throws on unknown id — no invented fallback (V4). */
  get(id: ItemId): ItemDef {
    const def = this.defs.get(id as number);
    if (!def) throw new Error(`unknown item id ${id}`);
    return def;
  }

  weightOf(id: ItemId): number {
    return this.get(id).weightKg;
  }

  maxStackOf(id: ItemId): number {
    return this.get(id).maxStack!;
  }
}
