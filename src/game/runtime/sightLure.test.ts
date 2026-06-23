// B15 / V14 — sight overrides a stale sound lure. A horde that can see the player retargets onto the
// player even right after a gunshot (which arms a sound lure); you can't walk past zombies that see you
// while they chase an old shot location.
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';

const TIER = 'desktop-high' as const;
const TICK_DT = 1 / 30;

function makeRuntime() {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildTestBlock() });
}

describe('sight overrides sound lure (B16/V14)', () => {
  it('a horde that can see the player targets the player cell even after firing', () => {
    const rt = makeRuntime();
    const p = rt.player();
    // A zombie standing on the player is always within sight → the horde "sees" the player.
    rt.spawnZombie({ x: p.x, y: 0, z: p.z });
    rt.fire(1, 0, 'torsoUpper'); // arms a sound lure at the muzzle
    for (let i = 0; i < 8; i++) rt.update(TICK_DT); // run perception + sound intervals

    const c = rt.scene.navGrid.worldToCell(rt.player().x, rt.player().z);
    expect(rt.flowTargetCell).toBe(rt.scene.navGrid.index(c.cx, c.cy));
  });
});
