// Lane-S combat/weapons config — V4: new T16/T17/T18/T20/T21 tunables typed + in range.
// Separate file (isolated module graph) so domain registration happens exactly once here.
import { describe, it, expect } from 'vitest';
import { resolveDomain } from '../registry';
import { combatConfig } from './combat';
import { weaponsConfig } from './weapons';
import { perceptionConfig } from './perception';
import { zombiesConfig } from './zombies';
import { num } from '../spec';

const TIER = 'desktop-high' as const;

describe('lane-S combat-family config (V4)', () => {
  it('combat domain exposes the full T16/T17/T20 tunables in range', () => {
    const c = resolveDomain(combatConfig, TIER);
    expect(c.meleeActiveWindowTicks).toBeGreaterThan(0);
    expect(c.detachedPartSettleTicks).toBeGreaterThan(0);
    expect(c.legLossLocomotionPenalty).toBeGreaterThan(c.armLossLocomotionPenalty);
    expect(c.barricadeDamagePerThreshold).toBeGreaterThan(0);
    expect(typeof c.promoteOnDetailedHit).toBe('boolean');
  });

  it('weapons domain exposes melee + firearm penetration + sound tunables', () => {
    const w = resolveDomain(weaponsConfig, TIER);
    expect(w.firearmMagazineSize).toBeGreaterThan(0);
    expect(w.firearmMaxPenetrations).toBeGreaterThanOrEqual(1);
    expect(w.meleeArcDegrees).toBeGreaterThan(0);
    expect(w.gunfireSoundRadiusMeters).toBeGreaterThan(w.meleeSoundRadiusMeters);
  });

  it('perception + zombies expose behaviour + archetype stats', () => {
    const p = resolveDomain(perceptionConfig, TIER);
    const z = resolveDomain(zombiesConfig, TIER);
    expect(p.attackRangeMeters).toBeGreaterThan(0);
    expect(z.runnerMoveSpeed).toBeGreaterThan(z.shamblerMoveSpeed);
    expect(z.crawlerSeverScale).toBeGreaterThan(z.runnerSeverScale);
  });

  it('rejects invalid content (V4 — out of range throws, no silent fallback)', () => {
    expect(() => num({ owner: 'combat', unit: 'ratio', doc: 'x', default: 2, min: 0, max: 1 })).toThrow();
  });
});
