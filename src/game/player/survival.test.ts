// T22 tests — V31: slow pressure (not babysitting); sleep quality responds to security/pain/noise/
// temp; bleeding persists + is readable + treatable; infection surfaces via symptoms; panic is a flag
// not a lockout; the snapshot matches the frozen PlayerViewSnapshot shape.

import { describe, it, expect } from 'vitest';
import { SurvivalSystem } from './survival';
import type { EntityId } from '@/game/core/contracts';

const PLAYER = 1 as EntityId;
const calm = { threat: 0, noise: 0, encumbrance: 0 };

describe('survival — slow pressure (V31)', () => {
  it('needs build slowly: one in-game hour of calm activity barely moves hunger', () => {
    const s = new SurvivalSystem({ entity: PLAYER });
    s.update({ seconds: 3600, ...calm }); // a full in-game hour
    expect(s.state.hunger).toBeGreaterThan(0);
    expect(s.state.hunger).toBeLessThan(0.1); // not constant babysitting
    expect(s.state.thirst).toBeLessThan(0.15);
  });

  it('eating/drinking relieves the need', () => {
    const s = new SurvivalSystem({ entity: PLAYER, initial: { hunger: 0.6, thirst: 0.5 } });
    s.eat(0.4);
    s.drink(0.5);
    expect(s.state.hunger).toBeCloseTo(0.2);
    expect(s.state.thirst).toBe(0);
  });

  it('competence reduces decay (reliability, not power)', () => {
    const base = new SurvivalSystem({ entity: PLAYER, competence: 0 });
    const pro = new SurvivalSystem({ entity: PLAYER, competence: 1 });
    base.update({ seconds: 3600, ...calm });
    pro.update({ seconds: 3600, ...calm });
    expect(pro.state.hunger).toBeLessThan(base.state.hunger);
  });
});

describe('survival — sleep quality responds to inputs (V31)', () => {
  it('better security / lower pain / quiet / comfortable temp recovers more fatigue', () => {
    const good = new SurvivalSystem({ entity: PLAYER, initial: { fatigue: 0.9 } });
    const bad = new SurvivalSystem({ entity: PLAYER, initial: { fatigue: 0.9, pain: 0.6 } });

    const goodRes = good.sleep({ hours: 8, security: 1, noise: 0, tempDiscomfort: 0 });
    const badRes = bad.sleep({ hours: 8, security: 0.3, noise: 0.8, tempDiscomfort: 0.7 });

    expect(goodRes.quality).toBeGreaterThan(badRes.quality);
    expect(goodRes.fatigueRecovered).toBeGreaterThan(badRes.fatigueRecovered);
    expect(good.state.fatigue).toBeLessThan(bad.state.fatigue);
  });

  it('competence grants a settling-in sleep bonus', () => {
    const novice = new SurvivalSystem({ entity: PLAYER, competence: 0, initial: { fatigue: 0.9 } });
    const veteran = new SurvivalSystem({ entity: PLAYER, competence: 1, initial: { fatigue: 0.9 } });
    const cond = { hours: 6, security: 0.5, noise: 0.3, tempDiscomfort: 0.2 } as const;
    expect(veteran.sleep(cond).quality).toBeGreaterThan(novice.sleep(cond).quality);
  });
});

describe('survival — bleeding / pain / infection / panic', () => {
  it('bleeding drains health fast, clots slowly, and is treatable', () => {
    const s = new SurvivalSystem({ entity: PLAYER });
    s.wound(0.5);
    expect(s.state.bleeding).toBeCloseTo(0.5);
    s.update({ seconds: 5, ...calm });
    expect(s.state.health).toBeLessThan(1); // acute drain
    expect(s.state.pain).toBeGreaterThan(0); // pain readable from the wound
    s.treatWound(0.5);
    expect(s.state.bleeding).toBe(0);
  });

  it('untreated open wounds raise infection and surface symptoms', () => {
    const s = new SurvivalSystem({ entity: PLAYER });
    s.wound(0.3); // open wound
    s.update({ seconds: 2000, ...calm });
    expect(s.state.infection).toBeGreaterThan(0);
    expect(s.infectionSymptomatic).toBe(true);
  });

  it('high stress flags panic but never removes agency (just a flag)', () => {
    const s = new SurvivalSystem({ entity: PLAYER });
    for (let i = 0; i < 60; i++) s.update({ seconds: 5, threat: 1, noise: 0.5, encumbrance: 0 });
    expect(s.panicking).toBe(true);
    expect(s.alive).toBe(true); // still in control
  });

  it('stress bleeds off in safety', () => {
    const s = new SurvivalSystem({ entity: PLAYER, initial: { stress: 0.8 } });
    s.update({ seconds: 30, ...calm });
    expect(s.state.stress).toBeLessThan(0.8);
  });
});

describe('survival — stamina / sprint (escape lever, T22)', () => {
  it('sprinting drains stamina; not-sprinting regenerates it', () => {
    const s = new SurvivalSystem({ entity: PLAYER });
    expect(s.stamina).toBe(1);
    const applied = s.applyStamina(true, 1); // one second of sprint
    expect(applied).toBe(true);
    expect(s.stamina).toBeLessThan(1);
    const drained = s.stamina;
    s.applyStamina(false, 1); // release: regenerate
    expect(s.stamina).toBeGreaterThan(drained);
  });

  it('empty stamina disables sprint until it recovers above the start threshold (hysteresis)', () => {
    const s = new SurvivalSystem({ entity: PLAYER });
    // drain to empty (the loop stops the instant the pool bottoms out)
    for (let i = 0; i < 20 && s.stamina > 0; i++) s.applyStamina(true, 1);
    expect(s.stamina).toBe(0);
    expect(s.canSprint).toBe(false);
    // requesting sprint while exhausted does NOT sprint (locked) — it just recovers instead
    expect(s.applyStamina(true, 0.001)).toBe(false);
    // regenerate just below the threshold — still locked, still no sprint
    const min = s.settings.sprintMinStamina;
    while (s.stamina < min - 0.02) s.applyStamina(false, 0.1);
    expect(s.canSprint).toBe(false);
    expect(s.applyStamina(true, 0.001)).toBe(false);
    // recover above the threshold — sprint re-enables
    while (s.stamina < min + 0.02) s.applyStamina(false, 0.1);
    expect(s.canSprint).toBe(true);
    expect(s.applyStamina(true, 0.01)).toBe(true);
  });

  it('fatigue lowers available stamina (caps the pool + slows regen)', () => {
    const fresh = new SurvivalSystem({ entity: PLAYER, initial: { fatigue: 0 } });
    const tired = new SurvivalSystem({ entity: PLAYER, initial: { fatigue: 0.9 } });
    // exhausted player's pool is capped below full from the start
    expect(tired.maxStamina).toBeLessThan(fresh.maxStamina);
    expect(tired.stamina).toBeLessThanOrEqual(tired.maxStamina);
    expect(tired.stamina).toBeLessThan(1);
    // and regenerates slower toward its (lower) cap
    const tiredBefore = tired.stamina;
    const freshDrained = new SurvivalSystem({ entity: PLAYER, initial: { fatigue: 0, stamina: 0.5 } });
    const tiredDrained = new SurvivalSystem({ entity: PLAYER, initial: { fatigue: 0.9, stamina: 0.1 } });
    freshDrained.applyStamina(false, 1);
    tiredDrained.applyStamina(false, 1);
    expect(freshDrained.stamina - 0.5).toBeGreaterThan(tiredDrained.stamina - 0.1);
    expect(tired.stamina).toBe(tiredBefore); // untouched control
  });
});

describe('survival — snapshot (V1)', () => {
  it('produces a PlayerViewSnapshot with every HUD field', () => {
    const s = new SurvivalSystem({ entity: PLAYER, initial: { hunger: 0.2, pain: 0.1 } });
    s.update({ seconds: 10, threat: 0.2, noise: 0.1, encumbrance: 0.5 });
    const snap = s.snapshot();
    expect(snap.entity).toBe(PLAYER);
    expect(snap.encumbrance).toBe(0.5);
    for (const k of ['health', 'bleeding', 'pain', 'hunger', 'thirst', 'fatigue', 'stress', 'encumbrance'] as const) {
      expect(typeof snap[k]).toBe('number');
    }
  });
});
