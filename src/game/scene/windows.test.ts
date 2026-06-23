// T108 — authoritative window state: glass smashes (shot or zombie), boards add/remove, zombie attrition
// tears an entry. A window cell stays a BLOCKED wall in the nav grid at all times (§G — windows are
// projectile/visual openings, never walk-through holes); `isOpening` is the shot/sight-occlusion predicate.
import { describe, it, expect } from 'vitest';
import { NavGrid } from '@/game/navigation';
import { WindowSystem, type WindowPlacement, type WindowSystemConfig } from './windows';

const CFG: WindowSystemConfig = { maxBoards: 3, glassShotsToSmash: 1, ticksToBreakBoard: 10, ticksToSmashGlass: 5 };

/** A wall along cy=3 with a single window cell at cx=3 carrying `state`. */
function wallWithWindow(state: WindowPlacement['state']): { grid: NavGrid; nav: number; placement: WindowPlacement } {
  const grid = new NavGrid({ width: 7, height: 7 });
  for (let cx = 0; cx < 7; cx++) grid.block(cx, 3); // solid wall — the window cell is a blocked facade cell
  const cs = grid.settings.navCellSize;
  const placement: WindowPlacement = { cx: 3, cy: 3, ns: false, slot: 0, state, storeys: 1, x: (3 + 0.5) * cs, z: (3 + 0.5) * cs };
  return { grid, nav: grid.index(3, 3), placement };
}

describe('WindowSystem (T108)', () => {
  it('a window NEVER changes nav passability — the cell stays a blocked wall (§G room-seal)', () => {
    const open = wallWithWindow('broken'); // authored glassless opening
    const sys = new WindowSystem(open.grid, [open.placement], CFG);
    expect(open.grid.isBlocked(open.nav)).toBe(true); // still a wall for nav, even though it is an opening
    expect(sys.isOpening(open.nav)).toBe(true); // ...but a projectile/sight line passes through it
  });

  it('isOpening tracks state: intact glass + boarded windows are NOT openings; smashed/glassless are', () => {
    const intact = wallWithWindow('intact');
    expect(new WindowSystem(intact.grid, [intact.placement], CFG).isOpening(intact.nav)).toBe(false);
    const boarded = wallWithWindow('boarded');
    expect(new WindowSystem(boarded.grid, [boarded.placement], CFG).isOpening(boarded.nav)).toBe(false);
    const broken = wallWithWindow('broken');
    expect(new WindowSystem(broken.grid, [broken.placement], CFG).isOpening(broken.nav)).toBe(true);
  });

  it('a BOARDED window starts at maxBoards; prying them all off opens it; boarding re-seals it', () => {
    const { grid, nav, placement } = wallWithWindow('boarded');
    const sys = new WindowSystem(grid, [placement], CFG);
    expect(sys.boardsOf(nav)).toBe(CFG.maxBoards);
    expect(sys.isOpening(nav)).toBe(false);
    for (let i = 0; i < CFG.maxBoards; i++) expect(sys.removeBoard(nav)).toBe(true);
    expect(sys.boardsOf(nav)).toBe(0);
    expect(sys.isOpening(nav)).toBe(true); // fully unboarded glassless hole — a shoot/see-through gap
    expect(sys.addBoard(nav)).toBe(true);
    expect(sys.isOpening(nav)).toBe(false); // a single board re-seals it
  });

  it('smashing INTACT glass opens the gap; applyGlassHit honours the pane HP', () => {
    const { grid, nav, placement } = wallWithWindow('intact');
    const sys = new WindowSystem(grid, [placement], CFG);
    expect(sys.smashGlass(nav)).toBe(true);
    expect(sys.glassOf(nav)).toBe('smashed');
    expect(sys.isOpening(nav)).toBe(true);

    const tough = wallWithWindow('intact');
    const sys2 = new WindowSystem(tough.grid, [tough.placement], { ...CFG, glassShotsToSmash: 2 });
    expect(sys2.applyGlassHit(tough.nav)).toBe(false); // first hit cracks but holds
    expect(sys2.isOpening(tough.nav)).toBe(false);
    expect(sys2.applyGlassHit(tough.nav)).toBe(true); // second shatters
    expect(sys2.isOpening(tough.nav)).toBe(true);
  });

  it('zombie attrition tears boards off first, then smashes the pane over the configured ticks', () => {
    const { grid, nav, placement } = wallWithWindow('intact');
    const sys = new WindowSystem(grid, [placement], CFG);
    sys.addBoard(nav); // an intact pane behind one board
    expect(sys.boardsOf(nav)).toBe(1);

    sys.tick([nav], CFG.ticksToBreakBoard - 1); // not enough yet
    expect(sys.boardsOf(nav)).toBe(1);
    expect(sys.tick([nav], 1)).toEqual([nav]); // crosses the board threshold
    expect(sys.boardsOf(nav)).toBe(0);
    expect(sys.glassOf(nav)).toBe('intact'); // glass still there, just unboarded

    sys.tick([nav], CFG.ticksToSmashGlass); // now the pane smashes
    expect(sys.glassOf(nav)).toBe('smashed');
    expect(sys.isOpening(nav)).toBe(true);
    expect(grid.isBlocked(nav)).toBe(true); // ...yet the cell is STILL a nav wall (§G preserved)
  });

  it('nearest returns the closest window in reach, none beyond range', () => {
    const grid = new NavGrid({ width: 12, height: 12 });
    for (let cx = 0; cx < 12; cx++) grid.block(cx, 5);
    const cs = grid.settings.navCellSize;
    const a: WindowPlacement = { cx: 2, cy: 5, ns: false, slot: 0, state: 'intact', storeys: 1, x: (2 + 0.5) * cs, z: (5 + 0.5) * cs };
    const b: WindowPlacement = { cx: 9, cy: 5, ns: false, slot: 1, state: 'intact', storeys: 1, x: (9 + 0.5) * cs, z: (5 + 0.5) * cs };
    const sys = new WindowSystem(grid, [a, b], CFG);
    expect(sys.nearest(a.x, a.z, 3)?.window.cx).toBe(2);
    expect(sys.nearest(0, 0, 0.5)).toBeNull();
  });
});
