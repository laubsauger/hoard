// SIM lane — the fight is LETHAL. Proves: a zombie that reaches the player damages it on a per-archetype
// cooldown (V14/V16), accumulated bites kill the player -> a one-shot 'dead' game-over transition + the
// snapshot carries a 0 health (V1), a STAGGERED body neither moves nor attacks until its timer expires
// (T57/V17 consumption — combat-set transient state is NOT clobbered by the per-tick FSM overwrite), and a
// LEGLESS body crawls (much slower locomotion, V17). Determinism: all attacks resolve on fixed ticks.

import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { createPlayerViewStore, createMapViewStore, createSessionStore } from '@/stores';
import { ZombieState } from '@/game/simulation';
import { regionBit } from '@/game/combat';
import { resolveDomain } from '@/config/registry';
import { zombiesConfig } from '@/config/domains/zombies';
import { playerConfig } from '@/config/domains/player';

const TIER = 'desktop-high' as const;
const TICK_DT = 1 / 30; // tickHz = 30 -> exactly one fixed tick per update() (V12)
const Z = resolveDomain(zombiesConfig, TIER);
const PLAYER = resolveDomain(playerConfig, TIER);

function makeRuntime() {
  const adapter = new InMemoryPersistenceAdapter();
  const playerStore = createPlayerViewStore();
  const mapStore = createMapViewStore();
  const sessionStore = createSessionStore();
  const rt = new GameRuntime({
    tier: TIER,
    adapter,
    scene: buildTestBlock(),
    playerStore,
    mapStore,
    sessionStore,
  });
  return { rt, playerStore, mapStore, sessionStore };
}

/** Spawn one zombie at `offset` metres in front of (+x of) the player so it is inside the forward vision
 *  cone (default heading 0 faces +x) — i.e. a body the player has actually been reached by. */
function spawnInFrontOfPlayer(rt: GameRuntime, offsetMeters: number) {
  const p = rt.player();
  const entity = rt.spawnZombie({ x: p.x - offsetMeters, y: 0, z: p.z });
  const slot = rt.slotOf(entity)!;
  return { entity, slot };
}

function ticks(rt: GameRuntime, n: number): void {
  for (let i = 0; i < n; i++) rt.update(TICK_DT);
}

describe('lethal fight: a reached zombie damages the player on cooldown (V14/V16)', () => {
  it('lands exactly one bite, then gates further bites by the archetype cooldown', () => {
    const { rt } = makeRuntime();
    spawnInFrontOfPlayer(rt, 0.5); // within the arrival ring + attack reach
    const bite = Z.shamblerAttackDamage / PLAYER.maxHealth; // normalized per-hit health loss

    expect(rt.playerHealthFraction()).toBe(1);

    // perception (every 4 ticks) flips the body to Attack at tick 4; the attack step bites that same tick.
    ticks(rt, 4);
    expect(rt.playerHealthFraction()).toBeCloseTo(1 - bite, 5);

    // a few ticks later it is still on cooldown — no second bite.
    ticks(rt, 5);
    expect(rt.playerHealthFraction()).toBeCloseTo(1 - bite, 5);

    // step well past the shambler cooldown -> a second bite lands.
    const cooldownTicks = Math.round(Z.shamblerAttackCooldownSeconds / TICK_DT);
    ticks(rt, cooldownTicks + 4);
    expect(rt.playerHealthFraction()).toBeCloseTo(1 - 2 * bite, 5);
  });
});

describe('lethal fight: accumulated bites kill the player -> game-over (V1)', () => {
  it('drives health to 0, flips isPlayerDead, sets the dead phase, and halts control', () => {
    const { rt, playerStore, sessionStore } = makeRuntime();
    spawnInFrontOfPlayer(rt, 0.5);

    expect(rt.isPlayerDead()).toBe(false);
    expect(sessionStore.getState().phase).not.toBe('dead');

    // bites of 0.08 each on a 1.5s cooldown: ~13 bites kill. Step generously past that.
    const bite = Z.shamblerAttackDamage / PLAYER.maxHealth;
    const cooldownTicks = Math.round(Z.shamblerAttackCooldownSeconds / TICK_DT);
    const needed = Math.ceil(1 / bite) + 1;
    ticks(rt, needed * cooldownTicks + 8);

    expect(rt.playerHealthFraction()).toBe(0);
    expect(rt.isPlayerDead()).toBe(true);
    // game-over signal: the session lifecycle phase is published as 'dead' (the UI shows game-over).
    expect(sessionStore.getState().phase).toBe('dead');

    // the player-view snapshot carries the lethal state — health reaches 0 (V1: snapshot is all primitives).
    const snap = playerStore.getState().snapshot;
    expect(snap).not.toBeNull();
    expect(snap!.health).toBe(0);
    // primitives only (numbers + the equipped-weapon id string, T138) — never an object/array (V1).
    for (const v of Object.values(snap!)) expect(typeof v === 'number' || typeof v === 'string').toBe(true);

    // control is halted: a dead player cannot move.
    const before = { ...rt.player() };
    expect(rt.movePlayer(1, 0, TICK_DT)).toBe(false);
    expect(rt.player().x).toBe(before.x);
  });
});

describe('lethal fight: stagger interrupts the body (T57/V17 consumption)', () => {
  it('a staggered body neither moves nor attacks until the stateTimer expires', () => {
    const { rt } = makeRuntime();
    // adjacent so it WOULD attack; stagger must suppress that until the timer runs out.
    const { slot } = spawnInFrontOfPlayer(rt, 0.5);

    // drive the body into stagger directly (mirrors what the combat lane writes on a wounding hit).
    const staggerSeconds = 0.6; // > 10 ticks at 30 Hz; concrete value only matters relative to the steps below
    rt.zombies.setState(slot, ZombieState.Stagger);
    rt.zombies.setStateTimer(slot, staggerSeconds);

    const before: [number, number, number] = [0, 0, 0];
    rt.zombies.getPosition(slot, before);

    // within the stagger window (10 ticks < ~18): no bite, no movement, still staggered (timer ticking down).
    ticks(rt, 10);
    expect(rt.playerHealthFraction()).toBe(1); // interrupted — never swung
    const mid: [number, number, number] = [0, 0, 0];
    rt.zombies.getPosition(slot, mid);
    expect(mid[0]).toBe(before[0]);
    expect(mid[2]).toBe(before[2]);
    expect(rt.zombies.getState(slot)).toBe(ZombieState.Stagger);
    expect(rt.zombies.getStateTimer(slot)).toBeLessThan(staggerSeconds);

    // past expiry: the body recovers, perception re-acquires Attack, and it bites.
    ticks(rt, 20);
    expect(rt.zombies.getState(slot)).not.toBe(ZombieState.Stagger);
    expect(rt.playerHealthFraction()).toBeLessThan(1);
  });

  it('a staggered body away from the ring does not translate while staggered, then moves after', () => {
    const { rt } = makeRuntime();
    const { slot } = spawnInFrontOfPlayer(rt, 12); // far enough to be steering, not arrived
    rt.zombies.setState(slot, ZombieState.Stagger);
    rt.zombies.setStateTimer(slot, 0.6);

    const p = rt.player();
    const startDist = () => {
      const pos: [number, number, number] = [0, 0, 0];
      rt.zombies.getPosition(slot, pos);
      return Math.hypot(pos[0] - p.x, pos[2] - p.z);
    };
    const d0 = startDist();

    ticks(rt, 10); // staggered -> frozen
    expect(startDist()).toBeCloseTo(d0, 6);

    ticks(rt, 30); // recovered -> closes distance
    expect(startDist()).toBeLessThan(d0 - 0.2);
  });
});

describe('lethal fight: a legless body crawls (much slower, V17)', () => {
  it('a missing-both-legs body closes far less distance than an intact one over the same ticks', () => {
    const intactRt = makeRuntime().rt;
    const crawlRt = makeRuntime().rt;
    const START = 12;

    const intact = spawnInFrontOfPlayer(intactRt, START);
    const crawler = spawnInFrontOfPlayer(crawlRt, START);
    // sever both legs on the crawler -> locomotionScale collapses (legLossLocomotionPenalty per leg).
    crawlRt.zombies.setAnatomyFlags(crawler.slot, regionBit('legLeft') | regionBit('legRight'));

    const distOf = (rt: GameRuntime, slot: number): number => {
      const p = rt.player();
      const pos: [number, number, number] = [0, 0, 0];
      rt.zombies.getPosition(slot, pos);
      return Math.hypot(pos[0] - p.x, pos[2] - p.z);
    };

    const N = 40;
    ticks(intactRt, N);
    ticks(crawlRt, N);

    const intactClosed = START - distOf(intactRt, intact.slot);
    const crawlClosed = START - distOf(crawlRt, crawler.slot);

    expect(intactClosed).toBeGreaterThan(0.5); // the intact body advanced meaningfully
    expect(crawlClosed).toBeGreaterThan(0); // the crawler still advances...
    expect(crawlClosed).toBeLessThan(intactClosed * 0.5); // ...but much slower (legs gone)
  });
});
