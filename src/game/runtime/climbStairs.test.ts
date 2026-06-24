// P3b — agent level + climb (multi-floor). A synthetic two-storey scene (level 0 open, level 1 a sparse
// upstairs room reachable only via a stair link) exercises the level-aware runtime end-to-end:
//   - the player climbs the stairs (level 0 → level 1) by the explicit climb action;
//   - a zombie that senses the upstairs player paths to the stairs and CLIMBS after it;
//   - a single-storey world has no stair links, so climbing is a no-op and no agent ever changes level.

import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock, type TestBlock, type CellXY } from '@/game/scene';
import { NavGrid, RegionGraph, LevelNav } from '@/game/navigation';
import { StructuralModule } from '@/game/destruction';
import type { ModuleId } from '@/game/core/contracts';
import { InMemoryPersistenceAdapter } from '@/game/persistence';

const TIER = 'desktop-high' as const;
const TICK_DT = 1 / 30;

// A 12x6 district with a real second storey. Level 0 is fully open; level 1 is blocked everywhere EXCEPT a
// small upstairs room (cx 5..7, cy 2..3) — reachable only by the stair link at (5,2). Stairs connect the same
// cell index on both levels (all levels share the district cell dimensions, so a cell index means one XZ).
const W = 12;
const H = 6;
const STAIR: CellXY = { cx: 5, cy: 2 };
const UPSTAIRS_CELLS: readonly CellXY[] = [
  { cx: 5, cy: 2 },
  { cx: 6, cy: 2 },
  { cx: 7, cy: 2 },
  { cx: 5, cy: 3 },
  { cx: 6, cy: 3 },
  { cx: 7, cy: 3 },
];

function buildTwoStoreyScene(): TestBlock {
  const g0 = new NavGrid({ width: W, height: H });
  const g1 = new NavGrid({ width: W, height: H });
  // level 1 sparse: block everything, then carve the upstairs room.
  for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) g1.block(cx, cy);
  for (const c of UPSTAIRS_CELLS) g1.clear(c.cx, c.cy);

  const levelNav = new LevelNav([g0, g1]);
  levelNav.addStairLink(0, g0.index(STAIR.cx, STAIR.cy), 1, g1.index(STAIR.cx, STAIR.cy));

  const region = new RegionGraph();
  region.addRegion(0);
  const wall = new StructuralModule({ id: 1 as ModuleId, sizeX: 1, sizeY: 1, sizeZ: 1, seed: 1 });
  wall.addCell({ x: 0, y: 0, z: 0, material: 'brick', family: 0, strength: 100 });
  const cs = g0.settings.navCellSize;

  return {
    navGrid: g0,
    levelNav,
    region,
    wall,
    moduleId: 1 as ModuleId,
    worldVersion: 'p3b-twostorey-test',
    fractureFamily: 0,
    playerCell: STAIR, // the player starts at the foot of the stairs (level 0)
    spawnCenterCell: { cx: 1, cy: 2 },
    buildingBounds: { minCx: 0, maxCx: W - 1, minCy: 0, maxCy: H - 1 },
    exitCells: [],
    cellCenter: (cell) => ({ x: (cell.cx + 0.5) * cs, y: 0, z: (cell.cy + 0.5) * cs }),
    navCellForStructuralCell: () => STAIR,
    navIndex: (cell) => g0.index(cell.cx, cell.cy),
    isWalkableWorld: (x, z) => {
      const { cx, cy } = g0.worldToCell(x, z);
      if (cx < 0 || cy < 0 || cx >= g0.width || cy >= g0.height) return false;
      return !g0.isBlocked(g0.index(cx, cy));
    },
  };
}

describe('P3b player climb', () => {
  it('a player on a stair cell transitions to the upper level (same XZ)', () => {
    const rt = new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildTwoStoreyScene() });
    expect(rt.playerLevelValue()).toBe(0);
    const before = rt.player();
    const climbed = rt.climbStairs();
    expect(climbed).toBe(true);
    expect(rt.playerLevelValue()).toBe(1);
    // the player stays at the SAME world XZ (the stair stacks vertically), only the level changed.
    expect(rt.player().x).toBeCloseTo(before.x, 6);
    expect(rt.player().z).toBeCloseTo(before.z, 6);
    // climbing again descends back to the ground level.
    expect(rt.climbStairs()).toBe(true);
    expect(rt.playerLevelValue()).toBe(0);
  });

  it('a single-storey world never lets the player change level (no stair links)', () => {
    const rt = new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildTestBlock() });
    expect(rt.playerLevelValue()).toBe(0);
    expect(rt.climbStairs()).toBe(false);
    expect(rt.playerLevelValue()).toBe(0);
  });
});

describe('P3b zombie climb', () => {
  it('a zombie pathing to a target upstairs climbs the stairs after the player', () => {
    const rt = new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildTwoStoreyScene() });
    // player goes upstairs.
    expect(rt.climbStairs()).toBe(true);
    expect(rt.playerLevelValue()).toBe(1);
    // a zombie starts on the ground floor, a few cells west of the stairs, facing the player (+x).
    const z = rt.spawnZombie({ x: 1.5 * 2, y: 0, z: 2.5 * 2 });
    expect(rt.zombieLevel(z)).toBe(0);

    let climbed = false;
    for (let i = 0; i < 200; i++) {
      rt.update(TICK_DT);
      if (rt.zombieLevel(z) === 1) {
        climbed = true;
        break;
      }
    }
    expect(climbed).toBe(true);
  });
});
