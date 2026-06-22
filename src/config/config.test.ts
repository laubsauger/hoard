// T2 tests — V4: typed config, valid ranges, tier behavior, reject invalid (no fallbacks).

import { describe, it, expect, beforeEach } from 'vitest';
import { num, bool, enumOf, resolve, validateValue, validateSpec, ConfigError } from './spec';
import { registerDomain, resolveDomain, validateAll, __resetRegistry } from './registry';

describe('config spec validation (V4)', () => {
  it('builds a valid number spec and resolves its default', () => {
    const s = num({ owner: 'time', unit: 'hz', doc: 'x', default: 30, min: 10, max: 120 });
    expect(resolve(s, 'desktop-high')).toBe(30);
  });

  it('rejects a default outside the declared range at build time', () => {
    expect(() => num({ owner: 'time', unit: 'hz', doc: 'x', default: 200, min: 10, max: 120 })).toThrow(ConfigError);
  });

  it('rejects a tier override outside range', () => {
    expect(() =>
      num({ owner: 'time', unit: 'hz', doc: 'x', default: 30, min: 10, max: 120, tiers: { 'mobile-webgpu': 5 } }),
    ).toThrow(ConfigError);
  });

  it('rejects a non-integer default when integer is required', () => {
    expect(() => num({ owner: 'time', unit: 'count', doc: 'x', default: 1.5, min: 0, max: 10, integer: true })).toThrow(
      ConfigError,
    );
  });

  it('rejects min > max', () => {
    expect(() => num({ owner: 'time', unit: 'hz', doc: 'x', default: 5, min: 10, max: 1 })).toThrow(ConfigError);
  });

  it('resolves a per-tier override and inherits default for unset tiers', () => {
    const s = num({ owner: 'time', unit: 'hz', doc: 'x', default: 30, min: 10, max: 120, tiers: { 'mobile-webgpu': 20 } });
    expect(resolve(s, 'mobile-webgpu')).toBe(20);
    expect(resolve(s, 'desktop-high')).toBe(30);
  });

  it('validates enum membership', () => {
    const s = enumOf({ owner: 'game', doc: 'x', values: ['a', 'b'] as const, default: 'a' });
    expect(resolve(s, 'desktop-high')).toBe('a');
    expect(() => validateValue(s, 'c', 'test')).toThrow(ConfigError);
  });

  it('validates boolean type', () => {
    const s = bool({ owner: 'game', doc: 'x', default: true });
    expect(() => validateValue(s, 'nope', 'test')).toThrow(ConfigError);
    expect(() => validateSpec(s)).not.toThrow();
  });
});

describe('config registry (V4)', () => {
  beforeEach(() => __resetRegistry());

  it('registers a domain and resolves it for a tier', () => {
    const cfg = registerDomain('time', {
      tickHz: num({ owner: 'time', unit: 'hz', doc: 'x', default: 30, min: 10, max: 120, tiers: { 'mobile-webgpu': 20 } }),
    });
    expect(resolveDomain(cfg, 'desktop-high').tickHz).toBe(30);
    expect(resolveDomain(cfg, 'mobile-webgpu').tickHz).toBe(20);
  });

  it('rejects owner mismatch on register', () => {
    expect(() =>
      registerDomain('time', { bad: num({ owner: 'camera', unit: 'hz', doc: 'x', default: 30, min: 10, max: 120 }) }),
    ).toThrow(ConfigError);
  });

  it('rejects double registration of a domain', () => {
    registerDomain('time', { tickHz: num({ owner: 'time', unit: 'hz', doc: 'x', default: 30, min: 10, max: 120 }) });
    expect(() =>
      registerDomain('time', { tickHz: num({ owner: 'time', unit: 'hz', doc: 'x', default: 30, min: 10, max: 120 }) }),
    ).toThrow(ConfigError);
  });

  it('validateAll passes for well-formed registered domains', () => {
    registerDomain('time', { tickHz: num({ owner: 'time', unit: 'hz', doc: 'x', default: 30, min: 10, max: 120 }) });
    expect(() => validateAll()).not.toThrow();
  });
});
