// V82 / V53 — a window boards UP TO TWICE with two DISTINCT occlusion stages, resolved by the projectile
// query (`firstProjectileBlockerDistance`) which is window-aware via `WindowSystem.isOpening`:
//   • 0 OR 1 boards over a glassless pane = an OPENING — a round flies THROUGH (you can shoot the gap);
//   • 2 boards = CLOSED — the round STOPS at the window, exactly like a solid wall.
// Drives the real GameRuntime wiring (CombatSystem → firstProjectileBlockerDistance → WindowSystem). The
// window cell is a BLOCKED nav wall in every state (V68) — this is purely projectile occlusion.
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildCityBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';

const TIER = 'desktop-high' as const;

function makeRuntime() {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildCityBlock() });
}

/**
 * Walk the player up to the FIRST facade window (the proven reachable subject in `windowVault.test.ts`), make it
 * a glassless opening with EXACTLY `boards` boards, then fire a shot straight at the window. Returns the shot's
 * `stopDistanceMeters` + the player→window distance — fresh runtime each call so the mag is full (firedRounds 1).
 */
function fireAtNearestWindow(boards: number): { stop: number; winDist: number; cellSize: number; fired: number } {
  const rt = makeRuntime();
  const target = rt.windowViews()[0];
  expect(target).toBeDefined();
  // approach until the window is in interaction reach.
  for (let i = 0; i < 1200; i++) {
    const p = rt.player();
    const dx = target!.x - p.x;
    const dz = target!.z - p.z;
    if (Math.hypot(dx, dz) <= 2.0) break;
    rt.movePlayer(dx, dz, 0.05);
  }
  // normalize to a glassless, fully-UNBOARDED opening, then board to the requested stage.
  while (rt.unboardNearestWindow()) {
    /* strip every board (returns planks) */
  }
  rt.smashNearestWindow(); // smash an intact pane (no-op if it is already glassless)
  for (let b = 0; b < boards; b++) expect(rt.boardNearestWindow()).toBe(true); // hammer + planks in the default loadout

  // the SUBJECT is the window nearest the player now — confirm the state we set up.
  const p = rt.player();
  const subject = [...rt.windowViews()].sort(
    (a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z),
  )[0]!;
  expect(subject.glass).not.toBe('intact');
  expect(subject.boards).toBe(boards);

  const dx = subject.x - p.x;
  const dz = subject.z - p.z;
  const winDist = Math.hypot(dx, dz);
  const res = rt.fire(dx / (winDist || 1), dz / (winDist || 1), 'torsoUpper');
  return {
    stop: res.stopDistanceMeters ?? Number.POSITIVE_INFINITY,
    winDist,
    cellSize: rt.scene.navGrid.settings.navCellSize,
    fired: res.firedRounds ?? 0,
  };
}

describe('window projectile occlusion by board count (V82)', () => {
  it('a 2-board window STOPS the round at the window; a 0- or 1-board opening lets it fly PAST', () => {
    const open = fireAtNearestWindow(0); // glassless, no boards → opening
    const oneBoard = fireAtNearestWindow(1); // glassless, 1 board → STILL an opening (shoot the gap)
    const closed = fireAtNearestWindow(2); // glassless, 2 boards → CLOSED

    // every measured shot actually fired (full mag) so its stop distance is meaningful.
    expect(open.fired).toBe(1);
    expect(oneBoard.fired).toBe(1);
    expect(closed.fired).toBe(1);

    // the CLOSED window stops the round right at the pane (≈ player→window distance, within a couple cells) —
    // never the full weapon range.
    expect(closed.stop).toBeGreaterThan(0);
    expect(closed.stop).toBeLessThan(closed.winDist + 2 * closed.cellSize);

    // the OPENING (0 or 1 board) lets the round fly PAST the window — strictly further than the closed stop.
    expect(open.stop).toBeGreaterThan(closed.stop);
    expect(oneBoard.stop).toBeGreaterThan(closed.stop);
  });
});
