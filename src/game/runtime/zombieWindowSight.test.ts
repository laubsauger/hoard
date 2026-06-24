// V83/V84 — ZOMBIE sight is window-aware, IDENTICAL to the player's vision: a zombie sees the player THROUGH
// a see-through window (glassless / intact-glass / ≤1 board — glass is transparent) but a boarded-SHUT window
// (2 boards) occludes like a solid wall. Zombie perception routes its line-of-sight through the shared
// SEE-THROUGH `sightScene` (hordeSystems.stepPerception), so this is the same predicate the player vision +
// flashlight use — no parallel, cell-only LOS that ignores the window edge.

import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildCityBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';

const TIER = 'desktop-high' as const;

function makeRuntime() {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildCityBlock() });
}

describe('zombie sight through a window (V83/V84)', () => {
  it('sees the player through a see-through window; a boarded-shut window blocks it', () => {
    const rt = makeRuntime();
    const grid = rt.scene.navGrid;
    const cs = grid.settings.navCellSize;

    // The window nearest the player spawn (guaranteed reachable from the interior the player stands in).
    const spawn = rt.player();
    let win = rt.windowViews()[0]!;
    let best = Infinity;
    for (const w of rt.windowViews()) {
      const d = Math.hypot(w.x - spawn.x, w.z - spawn.z);
      if (d < best) { best = d; win = w; }
    }

    // Walk the player up to the window from the interior side (in reach of the board/unboard verbs).
    for (let i = 0; i < 2000; i++) {
      const p = rt.player();
      const dx = win.x - p.x;
      const dz = win.z - p.z;
      if (Math.hypot(dx, dz) <= 2.0) break;
      rt.movePlayer(dx, dz, 0.05);
    }
    const p = rt.player();
    expect(Math.hypot(win.x - p.x, win.z - p.z)).toBeLessThan(2.5); // actually reached it

    // Interior is the side the player approached from; snap to the dominant cardinal so the player↔zombie line
    // crosses the window cell perpendicular to the facade. The zombie sits two cells out on the exterior side.
    const ddx = p.x - win.x;
    const ddz = p.z - win.z;
    const inX = Math.abs(ddx) >= Math.abs(ddz) ? Math.sign(ddx) : 0;
    const inZ = Math.abs(ddx) >= Math.abs(ddz) ? 0 : Math.sign(ddz);
    const zx = win.x - inX * cs * 2;
    const zz = win.z - inZ * cs * 2;

    const z = rt.spawnZombie({ x: zx, y: 0, z: zz });
    const slot = rt.slotOf(z)!;
    rt.zombies.setHeading(slot, Math.atan2(p.z - zz, p.x - zx)); // face the player (vision cone)
    const pc = grid.worldToCell(p.x, p.z);
    const playerCell = grid.index(pc.cx, pc.cy);

    const boardsNow = (): number => rt.windowViews().find((w) => w.cx === win.cx && w.cy === win.cy)!.boards;

    // --- Phase 1: board the window SHUT (2 boards) → opaque wall. ---
    for (let i = 0; i < 4 && boardsNow() < 2; i++) rt.boardNearestWindow();
    expect(rt.isWindowSeeThrough(win.cx, win.cy)).toBe(false);
    rt.zombies.setPosition(slot, zx, 0, zz);
    rt.spatial.update(slot, zx, zz);
    for (let i = 0; i < 6; i++) rt.update(1 / 30);
    expect(rt.zombieTargetCell(z)).not.toBe(playerCell); // boarded-shut window blocks sight

    // --- Phase 2: clear the window to a see-through opening (pull boards, smash any glass). ---
    for (let i = 0; i < 4 && boardsNow() > 0; i++) rt.unboardNearestWindow();
    rt.smashNearestWindow(); // glassless hole (no-op if already broken) — unambiguously see-through
    expect(rt.isWindowSeeThrough(win.cx, win.cy)).toBe(true);
    rt.zombies.setPosition(slot, zx, 0, zz);
    rt.spatial.update(slot, zx, zz);
    for (let i = 0; i < 6; i++) rt.update(1 / 30);
    expect(rt.zombieTargetCell(z)).toBe(playerCell); // sees the player THROUGH the open window
  });
});
