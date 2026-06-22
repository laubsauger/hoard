// T2 / V4 — domain registry + resolver.
// Lanes register their own domain config file (additive, collision-free per the §T parallel protocol).
// validateAll() is the production gate: invalid content rejects rather than inventing fallbacks.

import { resolve, validateSpec, ConfigError } from './spec';
import {
  type AnySpec,
  type ConfigDomain,
  type DomainConfig,
  type QualityTier,
  type ResolvedDomain,
} from './types';

const registry = new Map<ConfigDomain, DomainConfig>();

/** Register a domain's config. Validates every spec's owner + ranges immediately. */
export function registerDomain<C extends DomainConfig>(domain: ConfigDomain, config: C): C {
  if (registry.has(domain)) {
    throw new ConfigError(`config domain '${domain}' already registered`);
  }
  for (const [key, spec] of Object.entries(config) as [string, AnySpec][]) {
    if (spec.owner !== domain) {
      throw new ConfigError(`config '${domain}.${key}' owner mismatch: declares '${spec.owner}'`);
    }
    validateSpec(spec);
  }
  registry.set(domain, config);
  return config;
}

/** Resolve a whole domain for a quality tier. */
export function resolveDomain<C extends DomainConfig>(config: C, tier: QualityTier): ResolvedDomain<C> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(config) as [string, AnySpec][]) {
    out[key] = resolve(spec, tier);
  }
  return out as ResolvedDomain<C>;
}

/** Re-validate every registered domain. Call at startup; throws aggregated error on invalid content. */
export function validateAll(): void {
  const errors: string[] = [];
  for (const [domain, config] of registry) {
    for (const [key, spec] of Object.entries(config) as [string, AnySpec][]) {
      try {
        if (spec.owner !== domain) throw new ConfigError(`owner mismatch '${spec.owner}'`);
        validateSpec(spec);
      } catch (e) {
        errors.push(`${domain}.${key}: ${(e as Error).message}`);
      }
    }
  }
  if (errors.length > 0) {
    throw new ConfigError(`invalid config (${errors.length}):\n  ${errors.join('\n  ')}`);
  }
}

/** Test/diagnostics helper — registered domain names. */
export function registeredDomains(): ConfigDomain[] {
  return [...registry.keys()];
}

/** Test-only reset. */
export function __resetRegistry(): void {
  registry.clear();
}
