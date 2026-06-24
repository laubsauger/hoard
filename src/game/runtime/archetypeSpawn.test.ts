// T124 / V89 (SIM lane) — the SPAWNED roster is the STANDARD / BLOATED / RUNNER trio with distinct stats +
// weighted spawn selection. Proves: (1) each archetype's RESOLVED stats match the intended ratios (config-as-
// truth, V4) — STANDARD baseline 1.0, BLOATED slower + much tougher, RUNNER faster + frailer; (2) the
// DETERMINISTIC weighted spawn pick produces a STANDARD-dominant mix (BLOATED + RUNNER sprinkled, ecology
// variants never spawned) and is replay-stable (V26 — same seed/order → identical roster); (3) a BLOATED body
// takes strictly MORE shots to kill than a RUNNER (the per-archetype spawn health drives hits-to-kill).

import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { buildArchetypeRegistry } from '@/game/zombie';

const TIER = 'desktop-high' as const;

function makeRuntime() {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildTestBlock() });
}

const registry = buildArchetypeRegistry(TIER);
const STANDARD = registry.indexOf('shambler');
const RUNNER = registry.indexOf('runner');
const BLOATED = registry.indexOf('bloated');
const ECOLOGY = ['crawler', 'armored', 'decayed', 'burned'].map((id) => registry.indexOf(id));

describe('T124/V89 — STANDARD/BLOATED/RUNNER resolved stats (config-as-truth)', () => {
  it('STANDARD is the unscaled baseline (1.0× speed)', () => {
    const std = registry.byIndexOf(STANDARD);
    expect(std.locomotion.moveSpeedScale).toBe(1.0);
    expect(std.durability.health).toBeGreaterThan(0);
  });

  it('BLOATED is SLOWER (0.55–0.65×) and much TOUGHER (1.8–2.2× health) than STANDARD', () => {
    const std = registry.byIndexOf(STANDARD);
    const bloated = registry.byIndexOf(BLOATED);
    const speedRatio = bloated.locomotion.moveSpeedScale / std.locomotion.moveSpeedScale;
    const healthRatio = bloated.durability.health / std.durability.health;
    expect(speedRatio).toBeGreaterThanOrEqual(0.55);
    expect(speedRatio).toBeLessThanOrEqual(0.65);
    expect(healthRatio).toBeGreaterThanOrEqual(1.8);
    expect(healthRatio).toBeLessThanOrEqual(2.2);
  });

  it('RUNNER is FASTER (1.5–1.7×) and FRAILER (0.5–0.7× health) than STANDARD', () => {
    const std = registry.byIndexOf(STANDARD);
    const runner = registry.byIndexOf(RUNNER);
    const speedRatio = runner.locomotion.moveSpeedScale / std.locomotion.moveSpeedScale;
    const healthRatio = runner.durability.health / std.durability.health;
    expect(speedRatio).toBeGreaterThanOrEqual(1.5);
    expect(speedRatio).toBeLessThanOrEqual(1.7);
    expect(healthRatio).toBeGreaterThanOrEqual(0.5);
    expect(healthRatio).toBeLessThanOrEqual(0.7);
  });

  it('STANDARD spawn weight DOMINATES (>= 70% of the roster); ecology variants never spawn (0)', () => {
    const weights = registry.spawnWeights();
    const total = weights.reduce((a, b) => a + b, 0);
    expect(weights[STANDARD]! / total).toBeGreaterThanOrEqual(0.7);
    expect(weights[RUNNER]!).toBeGreaterThan(0);
    expect(weights[BLOATED]!).toBeGreaterThan(0);
    expect(weights[STANDARD]!).toBeGreaterThan(weights[RUNNER]!);
    expect(weights[STANDARD]!).toBeGreaterThan(weights[BLOATED]!);
    for (const e of ECOLOGY) expect(weights[e]!).toBe(0);
  });
});

describe('T124/V89 — deterministic weighted spawn distribution', () => {
  /** Tally the spawned archetypes off the SoA after a weighted horde spawn. */
  function spawnTally(n: number): { counts: Map<number, number>; total: number } {
    const rt = makeRuntime();
    rt.spawnHorde(n, 18);
    const counts = new Map<number, number>();
    let total = 0;
    rt.zombies.forEachAlive((slot) => {
      const a = rt.zombies.getArchetype(slot);
      counts.set(a, (counts.get(a) ?? 0) + 1);
      total += 1;
    });
    return { counts, total };
  }

  it('STANDARD dominates the mix, BLOATED + RUNNER are sprinkled, ecology never appears', () => {
    const n = 300;
    const { counts, total } = spawnTally(n);
    expect(total).toBe(n);
    const std = counts.get(STANDARD) ?? 0;
    const runner = counts.get(RUNNER) ?? 0;
    const bloated = counts.get(BLOATED) ?? 0;
    // STANDARD is the dominant share (loose lower bound below the 76% target absorbs hash quantization).
    expect(std / total).toBeGreaterThan(0.6);
    // BLOATED + RUNNER actually show up but stay the minority.
    expect(runner).toBeGreaterThan(0);
    expect(bloated).toBeGreaterThan(0);
    expect(runner).toBeLessThan(std);
    expect(bloated).toBeLessThan(std);
    // the four zero-weight ecology variants are NEVER spawned by the default mix.
    for (const e of ECOLOGY) expect(counts.get(e) ?? 0).toBe(0);
    // the whole live population is one of exactly the three spawnable archetypes.
    expect(std + runner + bloated).toBe(total);
  });

  it('is replay-stable: the same count yields the identical archetype sequence (V26)', () => {
    const rtA = makeRuntime();
    const rtB = makeRuntime();
    const a = rtA.spawnHorde(50, 18).map((e) => rtA.zombies.getArchetype(rtA.slotOf(e)!));
    const b = rtB.spawnHorde(50, 18).map((e) => rtB.zombies.getArchetype(rtB.slotOf(e)!));
    expect(a).toEqual(b);
  });
});

describe('T124/V89 — per-archetype health drives hits-to-kill', () => {
  /** Fire deterministic targeted torso shots at one freshly-spawned body until it dies; return the shot count. */
  function shotsToKill(archetypeId: number): number {
    const rt = makeRuntime();
    const p = rt.player();
    const entity = rt.spawnZombie({ x: p.x + 3, y: 0, z: p.z }, archetypeId);
    let shots = 0;
    while (rt.isAliveEntity(entity)) {
      rt.fireAtEntity(entity, 'torsoUpper'); // targeted, non-fatal region → pure chip damage vs health
      shots += 1;
      if (shots > 40) throw new Error(`archetype ${archetypeId} never died (combat tuning regression?)`);
    }
    return shots;
  }

  it('a BLOATED body takes strictly MORE shots to kill than a RUNNER', () => {
    const runnerShots = shotsToKill(RUNNER);
    const bloatedShots = shotsToKill(BLOATED);
    expect(runnerShots).toBeGreaterThanOrEqual(1);
    expect(bloatedShots).toBeGreaterThan(runnerShots);
  });
});
