// T138 — weapon swap is gated to the classes the player CARRIES. The starter loadout has a knife (melee), a
// pistol, and a shotgun (NO rifle), so cycling visits only those three and never the un-carried rifle.
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { createPlayerViewStore, createMapViewStore } from '@/stores';

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

describe('runtime weapon swap (T138)', () => {
  it('carriedWeaponClasses reflects the loadout (melee + pistol + shotgun, no rifle)', () => {
    const rt = makeRuntime();
    const carried = rt.carriedWeaponClasses();
    expect(carried).toContain('pistol');
    expect(carried).toContain('shotgun');
    expect(carried).toContain('melee');
    expect(carried).not.toContain('rifle'); // no rifle item in the loadout → not swappable
  });

  it('cycling the weapon moves to a CARRIED class (the un-carried rifle is skipped)', () => {
    const rt = makeRuntime();
    expect(rt.currentWeaponId()).toBe('pistol'); // default equip
    rt.cycleWeapon(1); // pistol → next carried in registry order = shotgun (rifle skipped — not carried)
    expect(rt.currentWeaponId()).toBe('shotgun');
  });
});
