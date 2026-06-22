// T2 / V4 — spec builders + validation + tier resolution.
// Builders run validateSpec at construction time so invalid defaults/overrides throw immediately.

import {
  type AnySpec,
  type BoolSpec,
  type ConfigDomain,
  type EnumSpec,
  type NumberSpec,
  type QualityTier,
  type SpecValue,
  type Unit,
} from './types';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function specLabel(spec: AnySpec): string {
  return `[${spec.owner}] (${spec.kind}, ${spec.unit})`;
}

/** Validate a single value against a spec. Throws ConfigError on violation. No coercion, no fallback. */
export function validateValue(spec: AnySpec, value: unknown, where: string): void {
  switch (spec.kind) {
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new ConfigError(`${specLabel(spec)} ${where}: expected number, got ${String(value)}`);
      }
      if (spec.integer && !Number.isInteger(value)) {
        throw new ConfigError(`${specLabel(spec)} ${where}: expected integer, got ${value}`);
      }
      if (value < spec.min || value > spec.max) {
        throw new ConfigError(`${specLabel(spec)} ${where}: ${value} out of range [${spec.min}, ${spec.max}]`);
      }
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new ConfigError(`${specLabel(spec)} ${where}: expected boolean, got ${String(value)}`);
      }
      return;
    }
    case 'enum': {
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        throw new ConfigError(
          `${specLabel(spec)} ${where}: ${String(value)} not in {${spec.values.join(', ')}}`,
        );
      }
      return;
    }
  }
}

/** Validate a spec's own default + every tier override. Throws on any invalid content. */
export function validateSpec(spec: AnySpec): void {
  if (spec.kind === 'number' && spec.min > spec.max) {
    throw new ConfigError(`${specLabel(spec)}: min ${spec.min} > max ${spec.max}`);
  }
  validateValue(spec, spec.default, 'default');
  if (spec.tiers) {
    for (const [tier, v] of Object.entries(spec.tiers)) {
      validateValue(spec, v, `tier:${tier}`);
    }
  }
}

/** Resolve a spec to a concrete value for a tier. Unset tiers inherit `default`. */
export function resolve<S extends AnySpec>(spec: S, tier: QualityTier): SpecValue<S> {
  const override = spec.tiers?.[tier];
  const value = (override ?? spec.default) as SpecValue<S>;
  return value;
}

// ---- Builders ----

interface NumOpts {
  owner: ConfigDomain;
  unit: Unit;
  doc: string;
  default: number;
  min: number;
  max: number;
  integer?: boolean;
  tiers?: Partial<Record<QualityTier, number>>;
}

export function num(opts: NumOpts): NumberSpec {
  const spec: NumberSpec = {
    kind: 'number',
    owner: opts.owner,
    unit: opts.unit,
    doc: opts.doc,
    default: opts.default,
    min: opts.min,
    max: opts.max,
    ...(opts.integer !== undefined ? { integer: opts.integer } : {}),
    ...(opts.tiers !== undefined ? { tiers: opts.tiers } : {}),
  };
  validateSpec(spec);
  return spec;
}

interface BoolOpts {
  owner: ConfigDomain;
  doc: string;
  default: boolean;
  tiers?: Partial<Record<QualityTier, boolean>>;
}

export function bool(opts: BoolOpts): BoolSpec {
  const spec: BoolSpec = {
    kind: 'boolean',
    owner: opts.owner,
    unit: 'none',
    doc: opts.doc,
    default: opts.default,
    ...(opts.tiers !== undefined ? { tiers: opts.tiers } : {}),
  };
  validateSpec(spec);
  return spec;
}

interface EnumOpts<E extends string> {
  owner: ConfigDomain;
  doc: string;
  values: readonly E[];
  default: E;
  tiers?: Partial<Record<QualityTier, E>>;
}

export function enumOf<E extends string>(opts: EnumOpts<E>): EnumSpec<E> {
  const spec: EnumSpec<E> = {
    kind: 'enum',
    owner: opts.owner,
    unit: 'none',
    doc: opts.doc,
    values: opts.values,
    default: opts.default,
    ...(opts.tiers !== undefined ? { tiers: opts.tiers } : {}),
  };
  validateSpec(spec);
  return spec;
}
