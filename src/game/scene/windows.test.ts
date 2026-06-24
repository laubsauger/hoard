// T108 — authoritative window state: glass smashes (shot or zombie), boards add/remove, zombie attrition
// tears an entry. A window cell stays a BLOCKED wall in the nav grid at all times (§G — windows are
// projectile/visual openings, never walk-through holes); `isOpening` is the shot/sight-occlusion predicate.
import { describe, it, expect } from 'vitest';
import { NavGrid } from '@/game/navigation';
import { WindowSystem, BOARDS_TO_CLOSE, type WindowPlacement, type WindowSystemConfig } from './windows';
import { rayDistanceToWall, hasLineOfSight, type LosScene } from './testBlock';

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

  it('V84 isSeeThrough — GLASS IS TRANSPARENT: an INTACT pane is see-through (where isOpening is NOT), only 2 boards close it', () => {
    // Intact glass: NOT a projectile/reach opening, but sight + light DO pass (transparent pane).
    const intact = wallWithWindow('intact');
    const intactSys = new WindowSystem(intact.grid, [intact.placement], CFG);
    expect(intactSys.isOpening(intact.nav)).toBe(false); // a bullet must shatter it first
    expect(intactSys.isSeeThrough(intact.nav)).toBe(true); // ...but you can SEE/LIGHT through the glass

    // A glassless hole is see-through too; a SECOND board (BOARDS_TO_CLOSE) is what closes it, regardless of glass.
    const broken = wallWithWindow('broken');
    const sys = new WindowSystem(broken.grid, [broken.placement], CFG);
    expect(sys.isSeeThrough(broken.nav)).toBe(true); // 0 boards
    expect(sys.addBoard(broken.nav)).toBe(true);
    expect(sys.isSeeThrough(broken.nav)).toBe(true); // 1 board still see-through (gaps around the plank)
    expect(sys.addBoard(broken.nav)).toBe(true);
    expect(sys.isSeeThrough(broken.nav)).toBe(false); // 2 boards = boarded shut, opaque to sight + light
    expect(broken.nav).toBeGreaterThanOrEqual(0);
    expect(BOARDS_TO_CLOSE).toBe(2);
  });

  it('a BOARDED window starts at maxBoards; prying them all off opens it; boarding re-seals it', () => {
    const { grid, nav, placement } = wallWithWindow('boarded');
    const sys = new WindowSystem(grid, [placement], CFG);
    expect(sys.boardsOf(nav)).toBe(CFG.maxBoards);
    expect(sys.isOpening(nav)).toBe(false);
    for (let i = 0; i < CFG.maxBoards; i++) expect(sys.removeBoard(nav)).toBe(true);
    expect(sys.boardsOf(nav)).toBe(0);
    expect(sys.isOpening(nav)).toBe(true); // fully unboarded glassless hole — a shoot/see-through gap
    expect(sys.addBoard(nav)).toBe(true); // ONE board: still a shoot/see-through gap (only blocks bodily entry)
    expect(sys.isOpening(nav)).toBe(true); // V82 — a single board does NOT seal it; it takes a SECOND board
    expect(sys.addBoard(nav)).toBe(true); // SECOND board closes it
    expect(sys.isOpening(nav)).toBe(false); // V82 — 2 boards = CLOSED (occludes like a wall)
  });

  it('V82 two-stage boarding: an OPENING needs <2 boards for sight/shots; the 2nd board CLOSES it', () => {
    const { grid, nav, placement } = wallWithWindow('broken'); // authored glassless opening
    const sys = new WindowSystem(grid, [placement], CFG);
    expect(BOARDS_TO_CLOSE).toBe(2);
    // 0 boards (glassless): sight/projectile opening, AND the player can vault through.
    expect(sys.isOpening(nav)).toBe(true);
    expect(sys.isFullyOpen(nav)).toBe(true);
    // 1 board: STILL a sight/projectile opening (see/shoot through), but NO LONGER vault-able (entry blocked).
    expect(sys.addBoard(nav)).toBe(true);
    expect(sys.boardsOf(nav)).toBe(1);
    expect(sys.isOpening(nav)).toBe(true);
    expect(sys.isFullyOpen(nav)).toBe(false);
    // 2 boards: CLOSED — no sight/projectile through it, not vault-able.
    expect(sys.addBoard(nav)).toBe(true);
    expect(sys.boardsOf(nav)).toBe(2);
    expect(sys.isOpening(nav)).toBe(false);
    expect(sys.isFullyOpen(nav)).toBe(false);
    // a 3rd board (this CFG allows up to maxBoards=3) stays CLOSED — 2 is already the close threshold.
    expect(sys.addBoard(nav)).toBe(true);
    expect(sys.isOpening(nav)).toBe(false);
  });

  it('V82 zombie attrition still tears the LAST board off a 1-board glassless window (it is a sightOpening, not fullyOpen)', () => {
    const { grid, nav, placement } = wallWithWindow('broken'); // glassless
    const sys = new WindowSystem(grid, [placement], CFG);
    sys.addBoard(nav); // 1 board over the hole — a sightOpening, but NOT fullyOpen
    expect(sys.isOpening(nav)).toBe(true);
    expect(sys.tick([nav], CFG.ticksToBreakBoard)).toEqual([nav]); // the last board IS still attrited
    expect(sys.boardsOf(nav)).toBe(0);
    expect(sys.isFullyOpen(nav)).toBe(true);
    // now fully open: nothing left to attrite.
    expect(sys.tick([nav], CFG.ticksToBreakBoard)).toEqual([]);
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

describe('EDGE-windows (thin-wall house model)', () => {
  /** A fully-walkable grid with a window on the EDGE between (3,2) and (3,3) (dir 's' from the inner cell). The
   *  exterior wall edge is authored ON (a closed window blocks movement); the window state decides sight/shots. */
  function edgeFixture(state: WindowPlacement['state']) {
    const grid = new NavGrid({ width: 7, height: 7 });
    const cs = grid.settings.navCellSize;
    grid.setWallBetween(3, 2, 3, 3, true); // the window's exterior edge-wall (movement blocked at all states)
    const placement: WindowPlacement = {
      cx: 3, cy: 2, ns: true, slot: 0, state, storeys: 1, edgeDir: 's',
      x: (3 + 0.5) * cs, z: (2 + 1) * cs, // edge midpoint
    };
    const sys = new WindowSystem(grid, [placement], CFG);
    const nav = grid.index(3, 2); // an edge-window keys by its INNER room cell
    return { grid, cs, sys, nav };
  }

  it('keys by the INNER room cell; edgeCellOf resolves the window from EITHER side, -1 elsewhere', () => {
    const { grid, sys, nav } = edgeFixture('broken');
    expect(sys.edgeCellOf(3, 2, 3, 3)).toBe(nav); // inner -> outer
    expect(sys.edgeCellOf(3, 3, 3, 2)).toBe(nav); // outer -> inner (symmetric)
    expect(sys.edgeCellOf(3, 2, 4, 2)).toBe(-1); // a different edge of the same cell — no window
    expect(sys.edgeCellOf(0, 0, 1, 0)).toBe(-1); // unrelated edge
    expect(sys.edgeCellOf(3, 2, 5, 2)).toBe(-1); // not 4-neighbours
    expect(grid.isBlocked(nav)).toBe(false); // the INNER cell stays walkable (edge-window, not cell-window)
    expect(grid.isBlocked(grid.index(3, 3))).toBe(false); // ...and so does the outer cell
  });

  it('the WindowView reports its dir + the edge-midpoint centre', () => {
    const { cs, sys } = edgeFixture('intact');
    const view = sys.list()[0]!;
    expect(view.dir).toBe('s');
    expect(view.x).toBeCloseTo((3 + 0.5) * cs);
    expect(view.z).toBeCloseTo((2 + 1) * cs); // the boundary between (3,2) and (3,3)
  });

  it('smash/board mechanics are identical to a cell-window (state is reused)', () => {
    const { sys, nav } = edgeFixture('intact');
    expect(sys.isOpening(nav)).toBe(false);
    expect(sys.isSeeThrough(nav)).toBe(true); // intact glass is transparent
    expect(sys.smashGlass(nav)).toBe(true);
    expect(sys.isOpening(nav)).toBe(true);
    expect(sys.isFullyOpen(nav)).toBe(true);
    expect(sys.addBoard(nav)).toBe(true);
    expect(sys.isFullyOpen(nav)).toBe(false); // 1 board blocks bodily entry
    expect(sys.isOpening(nav)).toBe(true); // ...but still a shoot/see gap
    expect(sys.addBoard(nav)).toBe(true);
    expect(sys.isOpening(nav)).toBe(false); // 2 boards close it
  });

  it('edge-aware LOS: an OPEN edge-window passes the sightline across its walled edge; a CLOSED one blocks it', () => {
    const { grid, cs, sys, nav } = edgeFixture('broken'); // glassless opening
    const scene: LosScene = {
      isWalkableWorld: (x, z) => {
        const cx = Math.floor(x / cs);
        const cy = Math.floor(z / cs);
        if (cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height) return false;
        return !grid.isBlocked(grid.index(cx, cy));
      },
      navGrid: grid,
      // EDGE-aware predicate: the crossed seam (cx,cy)-(ncx,ncy) is queried per-edge.
      isWindowOpening: (cx, cy, ncx, ncy) => {
        if (ncx === undefined || ncy === undefined) return false;
        const e = sys.edgeCellOf(cx, cy, ncx, ncy);
        return e >= 0 && sys.isOpening(e);
      },
    };
    const a = { x: (3 + 0.5) * cs, z: (1 + 0.5) * cs }; // north of the edge
    const b = { x: (3 + 0.5) * cs, z: (4 + 0.5) * cs }; // south of the edge

    // 0 boards: the edge-wall would block, but the open window is a sight gap → LOS passes.
    expect(hasLineOfSight(scene, a.x, a.z, b.x, b.z)).toBe(true);
    // 2 boards = CLOSED: the edge blocks, no opening → LOS fails.
    expect(sys.addBoard(nav)).toBe(true);
    expect(sys.addBoard(nav)).toBe(true);
    expect(sys.isOpening(nav)).toBe(false);
    expect(hasLineOfSight(scene, a.x, a.z, b.x, b.z)).toBe(false);
    // a different (solid) exterior edge on the same inner cell stays opaque even while the window is open.
    grid.setWallBetween(3, 2, 4, 2, true); // a solid wall on the inner cell's 'e' edge
    expect(sys.removeBoard(nav)).toBe(true); // window open again
    const acrossSolid = hasLineOfSight(scene, (2 + 0.5) * cs, (2 + 0.5) * cs, (4 + 0.5) * cs, (2 + 0.5) * cs);
    expect(acrossSolid).toBe(false); // the solid 'e' edge blocks — the open 's' window must NOT leak through it
  });
});

describe('window-aware structural LOS (V82)', () => {
  // A solid wall along cy=3 with one window at (3,3). The LOS ray runs N→S at cx=3, crossing ONLY the window
  // cell of the wall row — so whether the line passes is decided entirely by the window's board state.
  function losFixture(state: WindowPlacement['state']) {
    const grid = new NavGrid({ width: 7, height: 7 });
    for (let cx = 0; cx < 7; cx++) grid.block(cx, 3);
    const cs = grid.settings.navCellSize;
    const placement: WindowPlacement = { cx: 3, cy: 3, ns: true, slot: 0, state, storeys: 1, x: (3 + 0.5) * cs, z: (3 + 0.5) * cs };
    const sys = new WindowSystem(grid, [placement], CFG);
    const nav = grid.index(3, 3);
    const scene: LosScene = {
      isWalkableWorld: (x, z) => {
        const cx = Math.floor(x / cs);
        const cy = Math.floor(z / cs);
        if (cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height) return false;
        return !grid.isBlocked(grid.index(cx, cy));
      },
      navGrid: grid,
      isWindowOpening: (cx, cy) => {
        const n = sys.cellOf(cx, cy);
        return n >= 0 && sys.isOpening(n);
      },
    };
    return { grid, cs, sys, nav, scene };
  }

  it('an OPEN (glassless, 0-board) window passes the sightline; a CLOSED (2-board) window blocks it', () => {
    const { cs, sys, nav, scene } = losFixture('broken'); // glassless opening
    const ox = (3 + 0.5) * cs;
    const oz = (1 + 0.5) * cs; // observer north of the wall (cy=1)
    const tx = ox;
    const tz = (5 + 0.5) * cs; // target south of the wall (cy=5) — the window cell (cy=3) lies between them
    const maxDist = cs * 6;
    const south = Math.PI / 2; // +z
    const wallFace = 3 * cs - oz; // distance from the observer to the wall row's near face (cy=3 starts at z=3cs)

    // 0 boards: the ray flies PAST the wall row (its only blocker, the window, is now open).
    const dOpen = rayDistanceToWall(scene, ox, oz, south, maxDist);
    expect(dOpen).toBeGreaterThan(wallFace + cs); // travelled at least a cell beyond the wall face
    expect(hasLineOfSight(scene, ox, oz, tx, tz)).toBe(true);

    // 2 boards = CLOSED: the ray stops AT the wall face, well short of the open reach; LOS is blocked.
    expect(sys.addBoard(nav)).toBe(true);
    expect(sys.addBoard(nav)).toBe(true);
    expect(sys.isOpening(nav)).toBe(false);
    const dClosed = rayDistanceToWall(scene, ox, oz, south, maxDist);
    expect(dClosed).toBeGreaterThan(0);
    expect(dClosed).toBeLessThan(wallFace + cs); // stopped at/near the wall face, not past it
    expect(dClosed).toBeLessThan(dOpen);
    expect(hasLineOfSight(scene, ox, oz, tx, tz)).toBe(false);

    // back to 1 board: STILL a sight opening — the line passes again (see/shoot through the gap).
    expect(sys.removeBoard(nav)).toBe(true);
    expect(sys.boardsOf(nav)).toBe(1);
    expect(hasLineOfSight(scene, ox, oz, tx, tz)).toBe(true);
  });

  it('an INTACT-glass window blocks the sightline (closed pane); without the predicate every window is opaque', () => {
    const { cs, grid, scene } = losFixture('intact');
    const ox = (3 + 0.5) * cs;
    const oz = (1 + 0.5) * cs;
    const tx = ox;
    const tz = (5 + 0.5) * cs;
    expect(hasLineOfSight(scene, ox, oz, tx, tz)).toBe(false); // intact pane is not an opening

    // the predicate is OPT-IN: a bare scene (no isWindowOpening) keeps every window opaque (fog/flashlight path).
    const bare: LosScene = { isWalkableWorld: scene.isWalkableWorld, navGrid: grid };
    const open = losFixture('broken'); // glassless, 0 boards — but queried WITHOUT the predicate
    expect(hasLineOfSight(bare, ox, oz, tx, tz)).toBe(false);
    expect(hasLineOfSight({ isWalkableWorld: open.scene.isWalkableWorld, navGrid: open.grid }, ox, oz, tx, tz)).toBe(false);
  });

  it('V84 SEE-THROUGH predicate: sight + light PASS an INTACT-glass window (where the projectile predicate blocks), 2 boards close it', () => {
    // Same N→S sightline through the lone window cell, but the scene uses the SEE-THROUGH predicate
    // (isSeeThrough) — the one player vision / zombie sight / flashlight use — instead of isOpening.
    const grid = new NavGrid({ width: 7, height: 7 });
    for (let cx = 0; cx < 7; cx++) grid.block(cx, 3);
    const cs = grid.settings.navCellSize;
    const placement: WindowPlacement = { cx: 3, cy: 3, ns: true, slot: 0, state: 'intact', storeys: 1, x: (3 + 0.5) * cs, z: (3 + 0.5) * cs };
    const sys = new WindowSystem(grid, [placement], CFG);
    const nav = grid.index(3, 3);
    const sightScene: LosScene = {
      isWalkableWorld: (x, z) => {
        const cx = Math.floor(x / cs);
        const cy = Math.floor(z / cs);
        if (cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height) return false;
        return !grid.isBlocked(grid.index(cx, cy));
      },
      navGrid: grid,
      isWindowOpening: (cx, cy) => {
        const n = sys.cellOf(cx, cy);
        return n >= 0 && sys.isSeeThrough(n);
      },
    };
    const ox = (3 + 0.5) * cs;
    const oz = (1 + 0.5) * cs;
    const tx = ox;
    const tz = (5 + 0.5) * cs;

    // INTACT glass: the projectile predicate (isOpening) blocked the same shot above; the SEE-THROUGH predicate
    // lets the sight line / light beam pass — glass is transparent.
    expect(sys.isOpening(nav)).toBe(false);
    expect(hasLineOfSight(sightScene, ox, oz, tx, tz)).toBe(true);

    // Board it shut (2 boards): now even sight + light are occluded.
    expect(sys.addBoard(nav)).toBe(true);
    expect(sys.addBoard(nav)).toBe(true);
    expect(hasLineOfSight(sightScene, ox, oz, tx, tz)).toBe(false);
  });
});
