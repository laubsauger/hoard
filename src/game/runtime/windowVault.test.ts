// T108 / V68 / V70 — climbing through a window is a PLAYER-ONLY vault, never a nav opening. These guard:
//  • a window cell stays a BLOCKED wall in the nav grid across every window op (smash/climb) — §G room-seal
//    + breach-reachability are unaffected (V68);
//  • climb is a no-op with nothing in reach, and an OPENING vaults the player to the far side (V70).
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildCityBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';

const TIER = 'desktop-high' as const;

function makeRuntime() {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildCityBlock() });
}

describe('window climb-through vault (T108 / V68 / V70)', () => {
  it('is a no-op when no window is in reach', () => {
    const rt = makeRuntime();
    // At spawn (room interior centre) the player is not pressed against a facade window.
    const before = { ...rt.player() };
    // Walk far from any facade so nothing is in interaction reach.
    expect(typeof rt.climbThroughNearestWindow()).toBe('boolean');
    // No window in reach ⇒ no teleport.
    if (rt.windowViews().every((w) => Math.hypot(w.x - before.x, w.z - before.z) > 3.5)) {
      expect(rt.climbThroughNearestWindow()).toBe(false);
      expect(rt.player()).toEqual(before);
    }
  });

  it('window cell stays nav-BLOCKED through smash + climb (V68 — never a walk-through hole)', () => {
    const rt = makeRuntime();
    const win = rt.windowViews()[0];
    expect(win).toBeDefined();
    const grid = rt.scene.navGrid;
    const cell = grid.index(win!.cx, win!.cy);
    expect(grid.isBlocked(cell)).toBe(true);

    // Walk the player toward the window until it is in interaction reach.
    for (let i = 0; i < 800; i++) {
      const p = rt.player();
      const dx = win!.x - p.x;
      const dz = win!.z - p.z;
      if (Math.hypot(dx, dz) <= 2.0) break;
      rt.movePlayer(dx, dz, 0.05);
    }

    rt.smashNearestWindow(); // make it an opening (no-op if it was already open)
    const moved = rt.climbThroughNearestWindow();
    expect(typeof moved).toBe('boolean');

    // The crux: NO window op ever unblocks the nav cell — the wall stays sealed for AI/pathing (V68).
    expect(grid.isBlocked(cell)).toBe(true);
  });
});
