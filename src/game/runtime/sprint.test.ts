// Sprint lever on the GameRuntime (T22 escape mechanic): the optional `sprint` flag on movePlayer boosts
// move speed while stamina allows + drains the pool; releasing regenerates; a dead player never sprints.

import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildCityBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';

const TIER = 'desktop-high' as const;

function makeRuntime() {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildCityBlock() });
}

describe('runtime sprint lever (T22)', () => {
  it('sprinting covers more ground than walking over the same dt (open space)', () => {
    const walk = makeRuntime();
    const run = makeRuntime();
    const dt = 0.1;
    const w0 = { ...walk.player() };
    const r0 = { ...run.player() };
    walk.movePlayer(0, -1, dt, false);
    run.movePlayer(0, -1, dt, true);
    const walked = Math.abs(walk.player().z - w0.z);
    const sprinted = Math.abs(run.player().z - r0.z);
    expect(sprinted).toBeGreaterThan(walked);
  });

  it('drains stamina while sprinting and regenerates while walking', () => {
    const rt = makeRuntime();
    // sprint for a while in open space
    for (let i = 0; i < 30; i++) rt.movePlayer(0, -1, 0.1, true);
    const drained = rt.playerStaminaFraction();
    expect(drained).toBeLessThan(1);
    // walk (no sprint) to regenerate
    for (let i = 0; i < 10; i++) rt.movePlayer(0, 1, 0.1, false);
    expect(rt.playerStaminaFraction()).toBeGreaterThan(drained);
  });

  it('exhausted stamina removes the sprint boost (locked -> walk speed)', () => {
    // One huge-dt sprint call drains the pool past empty (the drain is applied before the walkable check,
    // so the player stays put against the wall but the stamina is spent) — leaving it exhausted + locked.
    const exhausted = makeRuntime();
    exhausted.movePlayer(0, -1, 100, true);
    expect(exhausted.playerStaminaFraction()).toBe(0);

    const walk = makeRuntime();
    const sprintFresh = makeRuntime();
    const e0 = { ...exhausted.player() };
    const w0 = { ...walk.player() };
    const s0 = { ...sprintFresh.player() };
    exhausted.movePlayer(0, -1, 0.1, true); // sprint requested but locked -> walks
    walk.movePlayer(0, -1, 0.1, false); // plain walk
    sprintFresh.movePlayer(0, -1, 0.1, true); // fresh sprint -> boosted
    const eStep = Math.abs(exhausted.player().z - e0.z);
    const wStep = Math.abs(walk.player().z - w0.z);
    const sStep = Math.abs(sprintFresh.player().z - s0.z);
    expect(eStep).toBeCloseTo(wStep, 5); // exhausted moves at walk speed
    expect(sStep).toBeGreaterThan(wStep); // a rested player gets the boost
  });

  it('a dead player cannot move or sprint', () => {
    const rt = makeRuntime();
    // a body right in front of the player bites it to death (mirrors the lethal-fight setup).
    const p = rt.player();
    rt.spawnZombie({ x: p.x - 0.5, y: 0, z: p.z });
    for (let i = 0; i < 6000 && !rt.isPlayerDead(); i++) rt.update(1 / 30);
    expect(rt.isPlayerDead()).toBe(true);
    const staminaBefore = rt.playerStaminaFraction();
    expect(rt.movePlayer(0, -1, 0.1, true)).toBe(false);
    expect(rt.playerStaminaFraction()).toBe(staminaBefore); // no drain — control is halted
  });
});
