// T40 — objective FSM: phase transitions, gated advancement, the evacuation countdown, and save/restore.

import { describe, it, expect } from 'vitest';
import { ObjectiveSystem, resolveObjectiveSettings } from './objective';

const TIER = 'desktop-high' as const;
const S = resolveObjectiveSettings(TIER);

function fresh() {
  return new ObjectiveSystem(S);
}

describe('objective: medium-term phase machine (T40, hybrid sandbox + direction)', () => {
  it('starts in locateParts and cannot advance until all parts are found', () => {
    const o = fresh();
    expect(o.currentPhase).toBe('locateParts');
    expect(o.canAdvance()).toBe(false);
    for (let i = 0; i < S.partsRequired - 1; i++) o.collectPart();
    expect(o.canAdvance()).toBe(false);
    o.collectPart();
    expect(o.canAdvance()).toBe(true);
    // parts cap at the requirement (no overflow)
    o.collectPart();
    expect(o.snapshot(0).partsFound).toBe(S.partsRequired);
  });

  it('advances locateParts -> repairRadio -> callEvacuation -> evacuating only when gated', () => {
    const o = fresh();
    expect(o.advance(0)).toBe(false); // not enough parts
    for (let i = 0; i < S.partsRequired; i++) o.collectPart();
    expect(o.advance(0)).toBe(true);
    expect(o.currentPhase).toBe('repairRadio');

    expect(o.advance(0)).toBe(false); // radio not repaired yet
    o.applyRepairTicks(S.repairRequiredTicks);
    expect(o.advance(0)).toBe(true);
    expect(o.currentPhase).toBe('callEvacuation');

    expect(o.advance(100)).toBe(true);
    expect(o.currentPhase).toBe('evacuating');
    expect(o.snapshot(100).evacuationTicksRemaining).toBe(S.evacuationCountdownTicks);
  });

  it('the player MAY linger indefinitely before evacuating (no hard timer until armed)', () => {
    const o = fresh();
    expect(o.tick(1_000_000)).toBe(false); // locateParts never times out
    for (let i = 0; i < S.partsRequired; i++) o.collectPart();
    o.advance(0);
    o.applyRepairTicks(S.repairRequiredTicks);
    expect(o.tick(2_000_000)).toBe(false); // repairRadio never times out
  });

  it('reaching the exit during evacuation wins; otherwise the countdown fails it', () => {
    const win = fresh();
    for (let i = 0; i < S.partsRequired; i++) win.collectPart();
    win.advance(0);
    win.applyRepairTicks(S.repairRequiredTicks);
    win.advance(0);
    win.advance(0); // -> evacuating, deadline = S.evacuationCountdownTicks
    expect(win.reachExit()).toBe(true);
    expect(win.currentPhase).toBe('evacuated');

    const lose = fresh();
    for (let i = 0; i < S.partsRequired; i++) lose.collectPart();
    lose.advance(0);
    lose.applyRepairTicks(S.repairRequiredTicks);
    lose.advance(0);
    lose.advance(0);
    const failedThisTick = lose.tick(S.evacuationCountdownTicks + 1);
    expect(failedThisTick).toBe(true);
    expect(lose.currentPhase).toBe('failed');
  });

  it('round-trips through save/restore (V9/V23) including the countdown deadline', () => {
    const o = fresh();
    for (let i = 0; i < S.partsRequired; i++) o.collectPart();
    o.advance(0);
    o.applyRepairTicks(S.repairRequiredTicks);
    o.advance(0);
    o.advance(500); // evacuating; deadline = 500 + countdown
    const saved = o.save();

    const restored = new ObjectiveSystem(S);
    restored.restore(saved);
    expect(restored.currentPhase).toBe('evacuating');
    expect(restored.snapshot(500).evacuationTicksRemaining).toBe(S.evacuationCountdownTicks);
    // the absolute deadline survived: failing past it still fails the restored objective
    expect(restored.tick(500 + S.evacuationCountdownTicks + 1)).toBe(true);
    expect(restored.currentPhase).toBe('failed');
  });

  it('rejects an unknown phase on restore (V4 — no silent coercion)', () => {
    const o = fresh();
    expect(() => o.restore({ phase: 'bogus' as never, partsFound: 0, repairProgressTicks: 0, evacuationDeadlineTick: null })).toThrow();
  });
});
