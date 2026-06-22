// T21 / V7 — ≥3 data-composed archetypes that differ by DATA only.
import { describe, it, expect } from 'vitest';
import { buildArchetypes, buildArchetypeRegistry, defineArchetype } from '@/game/zombie';
import { isSevered, limbConsequences, Posture } from '@/game/combat';
import { resolveDomain } from '@/config/registry';
import { combatConfig } from '@/config/domains/combat';

describe('T21 three data-composed archetypes', () => {
  it('builds shambler / runner / crawler', () => {
    const arr = buildArchetypes();
    expect(arr.map((a) => a.id).sort()).toEqual(['crawler', 'runner', 'shambler']);
  });

  it('all archetypes share ONE data shape — only values differ (not subclasses)', () => {
    const [a, b, c] = buildArchetypes();
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(a!)).toEqual(keys(b!));
    expect(keys(b!)).toEqual(keys(c!));
    // frozen authored data, no methods
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('expresses behavioural variation through data', () => {
    const reg = buildArchetypeRegistry();
    const shambler = reg.byIndexOf(reg.indexOf('shambler'));
    const runner = reg.byIndexOf(reg.indexOf('runner'));
    const crawler = reg.byIndexOf(reg.indexOf('crawler'));

    expect(runner.locomotion.moveSpeed).toBeGreaterThan(shambler.locomotion.moveSpeed);
    expect(crawler.locomotion.kind).toBe('crawl');
    // runner is fragile (severs more easily), crawler tough (severs less easily) — anatomical variation
    expect(runner.anatomy.severThresholdScale).toBeLessThan(shambler.anatomy.severThresholdScale);
    expect(crawler.anatomy.severThresholdScale).toBeGreaterThan(shambler.anatomy.severThresholdScale);
  });

  it('a crawler spawns legless → already in a crawl posture (anatomical composition)', () => {
    const crawler = buildArchetypes().find((a) => a.id === 'crawler')!;
    const flags = crawler.anatomy.initialAnatomyFlags;
    expect(isSevered(flags, 'legLeft')).toBe(true);
    expect(isSevered(flags, 'legRight')).toBe(true);
    expect(crawler.anatomy.severableRegions).not.toContain('legLeft');
    const c = limbConsequences(flags, resolveDomain(combatConfig, 'desktop-high'));
    expect(c.posture).toBe(Posture.Crawling);
  });

  it('defineArchetype rejects invalid content (V4/V7 — no silent fallback)', () => {
    const base = buildArchetypes()[0]!;
    expect(() => defineArchetype({ ...base, locomotion: { ...base.locomotion, moveSpeed: 0 } })).toThrow();
    expect(() => defineArchetype({ ...base, allowedSimTiers: [] })).toThrow();
  });

  it('registry assigns stable indices addressable as the SoA archetype field', () => {
    const reg = buildArchetypeRegistry();
    expect(reg.count).toBe(3);
    expect(reg.indexOf('shambler')).toBe(0);
    expect(() => reg.indexOf('zombie-king')).toThrow();
  });
});
