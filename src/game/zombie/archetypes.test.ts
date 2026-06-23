// T21 / V7 — ≥3 data-composed archetypes that differ by DATA only.
import { describe, it, expect } from 'vitest';
import { buildArchetypes, buildArchetypeRegistry, defineArchetype } from '@/game/zombie';
import { isSevered, limbConsequences, Posture } from '@/game/combat';
import { resolveDomain } from '@/config/registry';
import { combatConfig } from '@/config/domains/combat';

describe('T21 data-composed archetype roster', () => {
  it('builds the baseline trio plus grounded tiered-ecology variants', () => {
    const arr = buildArchetypes();
    expect(arr.map((a) => a.id).sort()).toEqual([
      'armored',
      'bloated',
      'burned',
      'crawler',
      'decayed',
      'runner',
      'shambler',
    ]);
  });

  it('all archetypes share ONE data shape — only values differ (not subclasses)', () => {
    const arr = buildArchetypes();
    const keys = (o: object) => Object.keys(o).sort();
    const ref = keys(arr[0]!);
    for (const a of arr) {
      expect(keys(a)).toEqual(ref);
      // frozen authored data, no methods
      expect(Object.isFrozen(a)).toBe(true);
    }
  });

  it('grounded variants are DISTINCT in stats (data, not new code paths)', () => {
    const reg = buildArchetypeRegistry();
    const at = (id: string) => reg.byIndexOf(reg.indexOf(id));
    const shambler = at('shambler');
    const armored = at('armored');
    const decayed = at('decayed');
    const burned = at('burned');
    const bloated = at('bloated');

    // armored: high armor + body very tanky (high sever scale), head still fatal, slow.
    expect(armored.durability.armor).toBeGreaterThan(shambler.durability.armor);
    expect(armored.durability.health).toBeGreaterThan(shambler.durability.health);
    expect(armored.anatomy.severThresholdScale).toBeGreaterThan(shambler.anatomy.severThresholdScale);
    expect(armored.anatomy.headFatal).toBe(true);
    expect(armored.locomotion.moveSpeed).toBeLessThan(shambler.locomotion.moveSpeed);

    // decayed: low health + falls apart easily (low sever threshold scale).
    expect(decayed.durability.health).toBeLessThan(shambler.durability.health);
    expect(decayed.anatomy.severThresholdScale).toBeLessThan(shambler.anatomy.severThresholdScale);

    // burned: a non-blood gore type (charred → ash/burned).
    expect(burned.gore).not.toBe('blood');
    expect(burned.gore).toBe('burned');

    // bloated: bursts on death (data flag for the render death-effect hook); others do not.
    expect(bloated.burstsOnDeath).toBe(true);
    expect(shambler.burstsOnDeath).toBe(false);

    // every archetype carries a valid gore palette key; the baseline trio bleeds blood.
    expect(shambler.gore).toBe('blood');
    expect(new Set([armored.gore, decayed.gore, burned.gore, bloated.gore]).size).toBeGreaterThan(1);
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
    expect(reg.count).toBe(7);
    // the baseline trio keeps its original stable indices (additive roster, no reordering).
    expect(reg.indexOf('shambler')).toBe(0);
    expect(reg.indexOf('runner')).toBe(1);
    expect(reg.indexOf('crawler')).toBe(2);
    expect(() => reg.indexOf('zombie-king')).toThrow();
  });

  it('rejects an unknown gore palette key (V4/V7 — no silent fallback)', () => {
    const base = buildArchetypes()[0]!;
    // @ts-expect-error — intentionally invalid gore value
    expect(() => defineArchetype({ ...base, gore: 'plasma' })).toThrow();
  });
});
