// T147 — torch: a melee weapon that (a) sets the struck zombie ALIGHT on a connecting swing (T145 burn), and
// (b) can be PLACED in the world as a persistent light source (consuming one from the pack).
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { createPlayerViewStore, createMapViewStore } from '@/stores';
import { ITEM, weaponClassForItem } from '@/game/inventory';

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

describe('torch (T147)', () => {
  it('is a melee weapon that ignites the zombie it strikes', () => {
    expect(weaponClassForItem(ITEM.Torch)).toBe('melee');
    const rt = makeRuntime();
    const p = rt.player();
    const slot = rt.slotOf(rt.spawnZombie({ x: p.x + 1, y: 0, z: p.z }))!; // within melee reach
    expect(rt.equipAndDraw(ITEM.Torch)).toBe(true);
    expect(rt.isTorchEquipped()).toBe(true);
    const shot = rt.fire(1, 0, 'torsoUpper'); // swing toward the zombie
    expect(shot.hit).toBe(true);
    expect(rt.isZombieBurning(slot)).toBe(true); // the torch set it alight
  });

  it('places a world torch (light source), consuming one from the pack', () => {
    const rt = makeRuntime();
    const pack = { entity: rt.playerEntity, container: 'player' } as const;
    expect(rt.inventory.count(pack, ITEM.Torch as never)).toBeGreaterThan(0);
    expect(rt.placedTorchMarkers().length).toBe(0);
    expect(rt.placeTorch()).toBe(true);
    expect(rt.placedTorchMarkers().length).toBe(1);
    expect(rt.inventory.count(pack, ITEM.Torch as never)).toBe(0);
    expect(rt.placeTorch()).toBe(false); // none left
  });
});
