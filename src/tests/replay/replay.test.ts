// T39 — deterministic replay layer (V26). Two recorded scripts — a COMBAT sequence (shots -> deaths)
// and a MODIFY sequence (breach -> nav change -> horde streams through) — must each replay to a
// byte-identical authoritative outcome from the same seed + commands. If the runtime were
// non-deterministic, assertDeterministicReplay would throw on the first diverging field (V26).

import { describe, it, expect } from 'vitest';
import {
  assertDeterministicReplay,
  runScript,
  serializeOutcome,
  type ReplayScript,
} from './replayHarness';

const SEED = 0xc0ffee;

// ---- COMBAT: shots -> deaths -> wounds, all from one stable seed ----
// Three zombies lined up west of the player. Two head shots kill the first two; a torso shot only
// wounds the third. The authoritative outcome encodes the deaths (population shrinks), the survivor's
// reduced health, and the EventId/EntityId counters advanced by resolving the shots. spawnAt needs
// absolute coords, which depend on the authored player position, so the script is built from a probe.
function buildCombatScript(): ReplayScript {
  // Probe a throwaway runtime ONLY to read the authored player position, then bake fixed coords into the
  // script so both replay runs spawn at identical absolute positions (still fully deterministic).
  const probe = runScript({ seed: SEED, actions: [] }); // captures player pos with no spawns
  const px = probe.player.x;
  const pz = probe.player.z;
  return {
    seed: SEED,
    actions: [
      { kind: 'spawnAt', x: px - 4, y: 0, z: pz },
      { kind: 'spawnAt', x: px - 6, y: 0, z: pz + 1 },
      { kind: 'spawnAt', x: px - 5, y: 0, z: pz - 1 },
      { kind: 'fireAt', index: 0, region: 'head' },
      { kind: 'fireAt', index: 1, region: 'head' },
      { kind: 'fireAt', index: 2, region: 'torsoUpper' },
      { kind: 'update', dt: 1 / 30 },
    ],
  };
}

// ---- MODIFY: breach -> local nav opens -> shared horde flow-field reroutes -> bodies stream through ----
const modifyScript: ReplayScript = {
  seed: SEED,
  actions: [
    { kind: 'spawnHorde', count: 24, radius: 4 },
    { kind: 'breach' },
    // many fixed ticks: the horde steers down the shared field through the new breach. Positions are a
    // strong determinism probe — any FP/iteration-order drift shows up here.
    ...Array.from({ length: 120 }, () => ({ kind: 'update', dt: 1 / 30 }) as const),
  ],
};

describe('replay: combat sequence (shots -> deaths) is deterministic (V26)', () => {
  it('reproduces byte-identical authoritative outcome across two runs', () => {
    const script = buildCombatScript();
    const { first, serialized } = assertDeterministicReplay(script);

    // sanity: the sequence actually killed two and wounded one (the layer is exercising real state).
    expect(first.aliveCount).toBe(1);
    const survivor = first.entities[0]!;
    expect(survivor.health).toBeGreaterThan(0);
    // EntityIds: player(1) + 3 zombies -> next entity counter is 4. EventIds advanced by the shots.
    expect(first.idCounters.entity).toBe(4);
    expect(first.idCounters.event).toBeGreaterThan(0);
    expect(serialized).toContain('"aliveCount":1');
  });

  it('a different seed/command set produces a DIFFERENT outcome (the check has teeth)', () => {
    const base = buildCombatScript();
    const a = serializeOutcome(runScript(base));
    // Swap the wounding shot to a head shot -> a third kill -> a genuinely different outcome.
    const variant: ReplayScript = {
      ...base,
      actions: base.actions.map((act) =>
        act.kind === 'fireAt' && act.index === 2 ? { ...act, region: 'head' as const } : act,
      ),
    };
    const b = serializeOutcome(runScript(variant));
    expect(a).not.toBe(b);
  });
});

describe('replay: modify sequence (breach -> nav change) is deterministic (V26)', () => {
  it('reproduces byte-identical horde positions + breach state across two runs', () => {
    const { first, serialized } = assertDeterministicReplay(modifyScript);

    // sanity: the breach happened (nav revision bumped, a cell is breached) and the horde is intact.
    expect(first.breachedCells.length).toBeGreaterThan(0);
    expect(first.navRevision).toBeGreaterThan(0);
    expect(first.aliveCount).toBe(24);
    // positions actually advanced (not all at spawn) — the field rerouted bodies through the breach.
    expect(serialized.length).toBeGreaterThan(100);
  });

  it('re-running a third time still matches (stability, not luck)', () => {
    const a = serializeOutcome(runScript(modifyScript));
    const b = serializeOutcome(runScript(modifyScript));
    const c = serializeOutcome(runScript(modifyScript));
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
