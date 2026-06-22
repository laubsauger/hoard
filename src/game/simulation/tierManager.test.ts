// T10 tests — tier policy + V13: promotion/demotion preserves identity/health/anatomy/state.

import { describe, it, expect } from 'vitest';
import { SimulationZombies, ZombieState } from './zombieStore';
import { TierManager, SimTier } from './tierManager';

const baseInputs = {
  distance: 200,
  visible: true,
  threat: 0,
  cameraImportance: 0,
  targeted: false,
  recentDamage: false,
  currentAttack: false,
  perfBudget: 1,
};

describe('TierManager.assign (T10)', () => {
  const tm = new TierManager();

  it('assigns tiers by distance band', () => {
    expect(tm.assign({ ...baseInputs, distance: 5 }).simTier).toBe(SimTier.Hero);
    expect(tm.assign({ ...baseInputs, distance: 30 }).simTier).toBe(SimTier.ActiveCrowd);
    expect(tm.assign({ ...baseInputs, distance: 100 }).simTier).toBe(SimTier.VisibleHorde);
    expect(tm.assign({ ...baseInputs, distance: 500 }).simTier).toBe(SimTier.Abstract);
  });

  it('mandatorily promotes a targeted/attacking/recently-damaged zombie to hero regardless of distance', () => {
    expect(tm.assign({ ...baseInputs, distance: 500, targeted: true }).simTier).toBe(SimTier.Hero);
    expect(tm.assign({ ...baseInputs, distance: 500, currentAttack: true }).simTier).toBe(SimTier.Hero);
    expect(tm.assign({ ...baseInputs, distance: 500, recentDamage: true }).simTier).toBe(SimTier.Hero);
  });

  it('discretionarily promotes for threat + camera importance, budget-gated', () => {
    // visible-horde distance, both promotion signals -> up two tiers to hero
    const promoted = tm.assign({ ...baseInputs, distance: 100, threat: 0.9, cameraImportance: 0.9 });
    expect(promoted.simTier).toBe(SimTier.Hero);
    // same signals but starved perf budget -> no discretionary promotion
    const starved = tm.assign({ ...baseInputs, distance: 100, threat: 0.9, cameraImportance: 0.9, perfBudget: 0 });
    expect(starved.simTier).toBe(SimTier.VisibleHorde);
  });

  it('caps render tier at abstract when off-screen but leaves sim tier intact', () => {
    const a = tm.assign({ ...baseInputs, distance: 5, visible: false });
    expect(a.simTier).toBe(SimTier.Hero); // authority preserved
    expect(a.renderTier).toBe(SimTier.Abstract); // not rendered richly
  });

  it('rejects invalid inputs (no silent fallback)', () => {
    expect(() => tm.assign({ ...baseInputs, distance: -1 })).toThrow();
    expect(() => tm.assign({ ...baseInputs, threat: 2 })).toThrow();
    expect(() => tm.assign({ ...baseInputs, perfBudget: -0.1 })).toThrow();
  });
});

describe('TierManager.apply preserves all other fields (V13)', () => {
  it('promotion/demotion changes only tier fields', () => {
    const store = new SimulationZombies(4);
    const slot = store.spawn({
      archetype: 7,
      position: [10, 0, 20],
      heading: 1.1,
      velocity: [1, 0, 1],
      state: ZombieState.Attack,
      health: 73,
      anatomyFlags: 0b1101, // some severed/disabled regions
      target: 2,
      navGroup: 4,
      simTier: SimTier.Abstract,
      renderTier: SimTier.Abstract,
      animState: 5,
      animPhase: 0.4,
    });
    store.setStateTimer(slot, 2.5);

    const tm = new TierManager();
    // Promote distant zombie to hero (e.g. it became the player's target mid hit-response).
    tm.update(store, slot, { ...baseInputs, distance: 500, targeted: true });
    expect(store.getSimTier(slot)).toBe(SimTier.Hero);

    // Every non-tier field is byte-for-byte preserved (data lives at the stable slot).
    expect(store.getArchetype(slot)).toBe(7);
    expect(store.getPosition(slot)).toEqual([10, 0, 20]);
    expect(store.getHeading(slot)).toBeCloseTo(1.1);
    expect(store.getVelocity(slot)).toEqual([1, 0, 1]);
    expect(store.getState(slot)).toBe(ZombieState.Attack);
    expect(store.getStateTimer(slot)).toBeCloseTo(2.5);
    expect(store.getHealth(slot)).toBe(73);
    expect(store.getAnatomyFlags(slot)).toBe(0b1101);
    expect(store.getTarget(slot)).toBe(2);
    expect(store.getNavGroup(slot)).toBe(4);
    expect(store.getAnimState(slot)).toBe(5);
    expect(store.getAnimPhase(slot)).toBeCloseTo(0.4);

    // Demote back to abstract — still preserves everything.
    tm.update(store, slot, { ...baseInputs, distance: 500 });
    expect(store.getSimTier(slot)).toBe(SimTier.Abstract);
    expect(store.getHealth(slot)).toBe(73);
    expect(store.getAnatomyFlags(slot)).toBe(0b1101);
  });

  it('apply reports whether a tier actually changed', () => {
    const store = new SimulationZombies(2);
    const slot = store.spawn({ archetype: 1, position: [5, 0, 0], health: 100, simTier: SimTier.Hero, renderTier: SimTier.Hero });
    const tm = new TierManager();
    const a = tm.assign({ ...baseInputs, distance: 5 }); // hero/hero — no change
    expect(tm.apply(store, slot, a)).toBe(false);
    const b = tm.assign({ ...baseInputs, distance: 500 }); // abstract — change
    expect(tm.apply(store, slot, b)).toBe(true);
  });
});
