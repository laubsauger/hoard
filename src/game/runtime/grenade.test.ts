// T142 — hand grenade: throwing consumes one from the pack + schedules a fused detonation; the blast kills
// zombies within the radius (falloff), leaves those outside untouched, and a killed body carries a RADIAL death
// impulse (away from the blast) so the corpse ragdoll launches outward (T134/V99). Player self-damage is honoured.
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { createPlayerViewStore, createMapViewStore } from '@/stores';
import { ITEM } from '@/game/inventory';
import type { ContainerRef, ItemId } from '@/game/core/contracts';

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

function posOf(rt: GameRuntime, slot: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  rt.zombies.getPosition(slot as never, out);
  return out;
}

describe('hand grenade (T142)', () => {
  it('throwing consumes one grenade; an empty pack throws nothing', () => {
    const rt = makeRuntime();
    const pack: ContainerRef = { entity: rt.playerEntity, container: 'player' };
    const start = rt.inventory.count(pack, ITEM.Grenade as ItemId);
    expect(start).toBeGreaterThan(0);
    expect(rt.throwGrenade(1, 0)).toBe(true);
    expect(rt.inventory.count(pack, ITEM.Grenade as ItemId)).toBe(start - 1);
    while (rt.inventory.count(pack, ITEM.Grenade as ItemId) > 0) rt.throwGrenade(1, 0);
    expect(rt.throwGrenade(1, 0)).toBe(false); // none left
  });

  it('detonation kills a zombie at the blast + radially launches its corpse', () => {
    const rt = makeRuntime();
    const p = rt.player();
    const entity = rt.spawnZombie({ x: p.x + 3, y: 0, z: p.z });
    const slot = rt.slotOf(entity)!;
    const [zx, , zz] = posOf(rt, slot);
    rt.detonateGrenade(zx, zz); // blast centred on the body
    expect(rt.zombies.isAlive(slot)).toBe(false); // centre damage is lethal
    const corpse = rt.corpses.list.find((c) => c.entity === (entity as unknown as number));
    expect(corpse).toBeDefined();
    expect(corpse!.impactForce).toBeGreaterThan(0); // a real radial launch impulse (ragdoll payoff)
    expect(rt.drainExplosions().length).toBe(1); // a flash was queued for the render lane
  });

  it('a zombie outside the blast radius is unscathed', () => {
    const rt = makeRuntime();
    const p = rt.player();
    const entity = rt.spawnZombie({ x: p.x + 3, y: 0, z: p.z });
    const slot = rt.slotOf(entity)!;
    const [zx, , zz] = posOf(rt, slot);
    const before = rt.zombies.getHealth(slot as never);
    rt.detonateGrenade(zx + 10, zz); // 10 m away — well outside the 5 m radius
    expect(rt.zombies.isAlive(slot)).toBe(true);
    expect(rt.zombies.getHealth(slot as never)).toBe(before); // no damage at all
  });

  it('a thrown grenade detonates after its fuse, not before', () => {
    const rt = makeRuntime();
    const p = rt.player();
    const entity = rt.spawnZombie({ x: p.x + 4, y: 0, z: p.z });
    const slot = rt.slotOf(entity)!;
    const [zx, , zz] = posOf(rt, slot);
    rt.throwGrenade(zx - p.x, zz - p.z); // aim at the zombie (within throw range)
    expect(rt.zombies.isAlive(slot)).toBe(true); // fuse still burning
    for (let i = 0; i < 45; i++) rt.update(1 / 30); // past the ~30-tick fuse
    expect(rt.zombies.isAlive(slot)).toBe(false); // detonated → killed
  });
});
