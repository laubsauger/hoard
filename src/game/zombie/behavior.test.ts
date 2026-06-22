// T20 / V14 — stimulus-driven perception + behaviour (NO omniscient player coords).
import { describe, it, expect } from 'vitest';
import { StimulusField } from '@/game/stimulus';
import { perceive, decide, newMemory, applyDecision } from '@/game/zombie';
import { ZombieState } from '@/game/simulation';
import { resolveDomain } from '@/config/registry';
import { perceptionConfig } from '@/config/domains/perception';
import type { Stimulus, StimulusId, StimulusKind, StimulusSource } from '@/game/core/contracts';
import type { PerceptionProfile } from '@/game/zombie';

const P = resolveDomain(perceptionConfig, 'desktop-high');
const SENSE: PerceptionProfile = { sightRange: 18, hearingRange: 36 };
const PERC_CFG = { alertIntensityThreshold: P.alertIntensityThreshold };
const BEHAVIOR_CFG = {
  soundUtilityWeight: P.soundUtilityWeight,
  sightUtilityWeight: P.sightUtilityWeight,
  agitationUtilityWeight: P.agitationUtilityWeight,
  fireAvoidUtilityWeight: P.fireAvoidUtilityWeight,
  investigateTicks: P.investigateTicks,
  attackRangeMeters: P.attackRangeMeters,
};

let nextId = 1;
function stim(
  kind: StimulusKind,
  source: StimulusSource,
  x: number,
  z: number,
  intensity = 1,
  radius = 40,
): Stimulus {
  return { id: nextId++ as unknown as StimulusId, kind, source, x, z, intensity, radius, bornTick: 0, decayPerTick: 0.01 };
}

describe('V14 zombies have NO omniscient player coords', () => {
  it('with an empty stimulus field, behaviour never targets anything (no player-position channel)', () => {
    const field = new StimulusField(16);
    // A "player" may be standing right next to the agent — but absent a stimulus, perceive() returns
    // nothing and decide() has no parameter through which player coords could ever arrive.
    const result = perceive(field, 0, 0, 0, SENSE, PERC_CFG);
    expect(result.perceived).toHaveLength(0);
    const d = decide(newMemory(), result, 0, 0, 0, BEHAVIOR_CFG);
    expect(d.state).toBe(ZombieState.Wander);
    expect(d.hasTarget).toBe(false);
  });

  it('a stimulus outside the archetype sense range is not perceived (range-gated, not omniscient)', () => {
    const field = new StimulusField(16);
    field.emit(stim('sound', 'gunfire', 5, 0, 1, 40), 0); // intensity reaches, but...
    const deaf: PerceptionProfile = { sightRange: 2, hearingRange: 2 }; // ...agent can't hear that far
    const result = perceive(field, 0, 0, 0, deaf, PERC_CFG);
    expect(result.perceived).toHaveLength(0);
  });
});

describe('V14 behaviour reacts to a queried stimulus', () => {
  it('pursues a heard sound toward its origin', () => {
    const field = new StimulusField(16);
    field.emit(stim('sound', 'gunfire', 6, 0, 1, 40), 0);
    const result = perceive(field, 0, 0, 0, SENSE, PERC_CFG);
    expect(result.perceived.length).toBeGreaterThan(0);
    const d = decide(newMemory(), result, 0, 0, 0, BEHAVIOR_CFG);
    expect(d.state).toBe(ZombieState.Pursue);
    expect(d.hasTarget).toBe(true);
    expect(d.targetX).toBeCloseTo(6);
  });

  it('attacks when the stimulus origin is within attack range', () => {
    const field = new StimulusField(16);
    field.emit(stim('sight', 'player', 1, 0, 1, 40), 0); // within attackRange (default 1.4)
    const result = perceive(field, 0, 0, 0, SENSE, PERC_CFG);
    const d = decide(newMemory(), result, 0, 0, 0, BEHAVIOR_CFG);
    expect(d.state).toBe(ZombieState.Attack);
  });

  it('flees fire — target points away from the fire origin', () => {
    const field = new StimulusField(16);
    field.emit(stim('fire', 'fire', 4, 0, 1, 40), 0);
    const result = perceive(field, 0, 0, 0, SENSE, PERC_CFG);
    const d = decide(newMemory(), result, 0, 0, 0, BEHAVIOR_CFG);
    expect(d.fleeing).toBe(true);
    expect(d.targetX).toBeLessThan(0); // moving away from the fire at +x
  });

  it('keeps investigating a faded stimulus until the memory expires', () => {
    const field = new StimulusField(16);
    field.emit(stim('sound', 'gunfire', 8, 0, 1, 40), 0);
    const mem = newMemory();
    applyDecision(mem, decide(mem, perceive(field, 0, 0, 0, SENSE, PERC_CFG), 0, 0, 0, BEHAVIOR_CFG));
    expect(mem.hasTarget).toBe(true);

    field.clear(); // stimulus gone
    const empty = perceive(field, 0, 0, 1, SENSE, PERC_CFG);
    const investigating = decide(mem, empty, 0, 0, 1, BEHAVIOR_CFG);
    expect(investigating.state).toBe(ZombieState.Pursue); // still heading to the last-known origin
    expect(investigating.targetX).toBeCloseTo(8);

    const expired = decide(mem, empty, 0, 0, BEHAVIOR_CFG.investigateTicks + 1, BEHAVIOR_CFG);
    expect(expired.state).toBe(ZombieState.Wander);
    expect(expired.hasTarget).toBe(false);
  });
});
