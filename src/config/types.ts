// T2 / V4 / V25 / V26 — config type system.
// Every config value carries: unit, domain owner, default, valid range, quality-tier behavior.
// Invalid content is rejected at registration (no silent fallbacks).

/** V25 — quality tiers selected from measured startup tests + adapter limits. */
export type QualityTier =
  | 'desktop-high'
  | 'desktop-medium'
  | 'desktop-compat'
  | 'mobile-webgpu';

export const QUALITY_TIERS: readonly QualityTier[] = [
  'desktop-high',
  'desktop-medium',
  'desktop-compat',
  'mobile-webgpu',
];

/** V26 — distinguish units in types so meters/cells/pixels/seconds/ticks/degrees/radians never mix silently. */
export type Unit =
  | 'meters'
  | 'cells'
  | 'pixels'
  | 'seconds'
  | 'ms'
  | 'ticks'
  | 'hz'
  | 'degrees'
  | 'radians'
  | 'ratio'
  | 'count'
  | 'bytes'
  | 'none';

/** §I — the 30 config domains. Each is owned by exactly one lane/system. */
export type ConfigDomain =
  | 'game'
  | 'world'
  | 'streaming'
  | 'time'
  | 'player'
  | 'survival'
  | 'items'
  | 'inventory'
  | 'crafting'
  | 'structures'
  | 'destruction'
  | 'fire'
  | 'zombies'
  | 'perception'
  | 'hordes'
  | 'navigation'
  | 'collision'
  | 'combat'
  | 'weapons'
  | 'camera'
  | 'rendering'
  | 'lighting'
  | 'shadows'
  | 'materials'
  | 'postFX'
  | 'weather'
  | 'audio'
  | 'UI'
  | 'input'
  | 'accessibility'
  | 'saving'
  | 'debug';

export const CONFIG_DOMAINS: readonly ConfigDomain[] = [
  'game', 'world', 'streaming', 'time', 'player', 'survival', 'items',
  'inventory', 'crafting', 'structures', 'destruction', 'fire', 'zombies',
  'perception', 'hordes', 'navigation', 'collision', 'combat', 'weapons',
  'camera', 'rendering', 'lighting', 'shadows', 'materials', 'postFX',
  'weather', 'audio', 'UI', 'input', 'accessibility', 'saving', 'debug',
];

interface BaseSpec<T> {
  readonly owner: ConfigDomain;
  readonly unit: Unit;
  readonly doc: string;
  readonly default: T;
  /** Per-tier overrides. A tier left unset inherits `default` (explicit tier-inheritance, not a fallback hack). */
  readonly tiers?: Partial<Record<QualityTier, T>>;
}

export interface NumberSpec extends BaseSpec<number> {
  readonly kind: 'number';
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
}

export interface BoolSpec extends BaseSpec<boolean> {
  readonly kind: 'boolean';
}

export interface EnumSpec<E extends string = string> extends BaseSpec<E> {
  readonly kind: 'enum';
  readonly values: readonly E[];
}

export type AnySpec = NumberSpec | BoolSpec | EnumSpec;

/** A domain config is a flat record of named specs. */
export type DomainConfig = Readonly<Record<string, AnySpec>>;

/** Resolved value type for a spec. */
export type SpecValue<S extends AnySpec> = S extends NumberSpec
  ? number
  : S extends BoolSpec
    ? boolean
    : S extends EnumSpec<infer E>
      ? E
      : never;

/** Resolved domain — same keys, values instead of specs. */
export type ResolvedDomain<C extends DomainConfig> = {
  readonly [K in keyof C]: SpecValue<C[K]>;
};
