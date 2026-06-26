// T145 — a zombie can CATCH FIRE: `igniteZombie` sets a burning status that takes burn DoT each tick (routing a
// burn death through the normal corpse/kill seam) and clears on death/burnout/despawn. (Spread between zombies is
// probabilistic/seeded — exercised in-game, not asserted here.)
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { createPlayerViewStore, createMapViewStore } from '@/stores';
import type { ZombieSlot } from '@/game/simulation';

const TIER = 'desktop-high' as const;

function makeRuntime(): GameRuntime {
  return new GameRuntime({
    tier: TIER,
    adapter: new InMemoryPersistenceAdapter(),
    scene: buildTestBlock(),
    playerStore: createPlayerViewStore(),
    mapStore: createMapViewStore(),
  });
}

describe('zombie burning (T145)', () => {
  it('an ignited zombie burns, takes DoT, then dies — and the status clears', () => {
    const rt = makeRuntime();
    const p = rt.player();
    const slot = rt.slotOf(rt.spawnZombie({ x: p.x + 3, y: 0, z: p.z }))!;
    expect(rt.isZombieBurning(slot)).toBe(false);

    rt.igniteZombie(slot);
    expect(rt.isZombieBurning(slot)).toBe(true);
    expect(rt.burningZombiePositions().length).toBe(1); // the render gets a flame position for it (T148)

    const hp0 = rt.zombies.getHealth(slot);
    rt.update(1 / 30);
    expect(rt.zombies.getHealth(slot)).toBeLessThan(hp0); // damage-over-time

    for (let i = 0; i < 400 && rt.zombies.isAlive(slot); i++) rt.update(1 / 30);
    expect(rt.zombies.isAlive(slot)).toBe(false); // burned to death
    expect(rt.isZombieBurning(slot)).toBe(false); // cleared on death/despawn
  });

  it('igniting an already-dead slot is a no-op (never throws / never re-burns)', () => {
    const rt = makeRuntime();
    const p = rt.player();
    const slot: ZombieSlot = rt.slotOf(rt.spawnZombie({ x: p.x + 3, y: 0, z: p.z }))!;
    rt.igniteZombie(slot);
    for (let i = 0; i < 400 && rt.zombies.isAlive(slot); i++) rt.update(1 / 30);
    expect(rt.zombies.isAlive(slot)).toBe(false); // dead + freed
    expect(() => rt.igniteZombie(slot)).not.toThrow();
    expect(rt.isZombieBurning(slot)).toBe(false); // a dead slot can't be set alight
  });
});
