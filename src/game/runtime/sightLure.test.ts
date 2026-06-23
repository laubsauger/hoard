// B15 / V14 — sight beats a heard sound for a zombie's OWN target. A zombie that can see the player
// targets the player cell even right after a gunshot (which emits a localized sound). Sight is the
// strongest pull; you can't walk past a zombie that sees you while it chases an old shot location.
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';

const TIER = 'desktop-high' as const;
const TICK_DT = 1 / 30;

function makeRuntime() {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildTestBlock() });
}

describe('sight beats a heard sound for the zombie that sees the player (B16/V14)', () => {
  it('a zombie that sees the player targets the player cell even after firing', () => {
    const rt = makeRuntime();
    const p = rt.player();
    // A zombie standing on the player is always within sight → it sees the player (clear LOS, in range).
    const z = rt.spawnZombie({ x: p.x, y: 0, z: p.z });
    rt.fire(1, 0, 'torsoUpper'); // emits a localized gunshot the zombie also hears
    for (let i = 0; i < 8; i++) rt.update(TICK_DT); // run perception so the zombie selects its target

    const c = rt.scene.navGrid.worldToCell(rt.player().x, rt.player().z);
    // The seen player wins over the heard shot: the zombie's chosen target is the player cell.
    expect(rt.zombieTargetCell(z)).toBe(rt.scene.navGrid.index(c.cx, c.cy));
  });
});
