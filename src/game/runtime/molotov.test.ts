// T146 — molotov cocktail: a thrown throwable that detonates ON LANDING (not after a fuse) into a lingering FIRE
// POOL which sets zombies alight (T145 burn) + expires after its duration.
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { createPlayerViewStore, createMapViewStore } from '@/stores';
import { ITEM } from '@/game/inventory';

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

describe('molotov cocktail (T146)', () => {
  it('lands → lights a fire pool that sets a zombie alight, then the pool expires', () => {
    const rt = makeRuntime();
    const p = rt.player();
    const slot = rt.slotOf(rt.spawnZombie({ x: p.x + 3, y: 0, z: p.z }))!;
    const pos: [number, number, number] = [0, 0, 0];
    rt.zombies.getPosition(slot as never, pos);

    rt.equipAndDraw(ITEM.Molotov); // active throwable = molotov → throw it at the zombie
    expect(rt.throwThrowable(pos[0] - p.x, pos[2] - p.z)).toBe(true);
    expect(rt.firePoolMarkers().length).toBe(0); // still arcing (no pool until it lands)

    for (let i = 0; i < 25; i++) rt.update(1 / 30); // past the ~18-tick flight → shatter + ignite
    expect(rt.firePoolMarkers().length).toBe(1); // a fire pool burns where it landed
    expect(rt.isZombieBurning(slot) || !rt.zombies.isAlive(slot)).toBe(true); // the zombie caught fire (or already burned down)

    for (let i = 0; i < 220; i++) rt.update(1 / 30); // past the pool duration (~6 s)
    expect(rt.firePoolMarkers().length).toBe(0); // pool burned out
  });
});
