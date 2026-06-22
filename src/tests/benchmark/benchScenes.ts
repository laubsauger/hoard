// T36 — authored benchmark geometry (lane X, tests-only). Each builder returns a TestBlock that the
// real GameRuntime drives unchanged (same contract as the GATE-0 test block and the M1 city block).
// Geometry here is authored level content (cell counts), exactly as testBlock.ts / cityBlock.ts treat
// literal grid sizes; the tunable counts/extents that the harness needs live in config.ts (V4).
//
// All scenes expose the single destructible `wall` the TestBlock contract requires. Scenes that do not
// breach park a harmless 1-cell wall at the grid corner; the breach-cascade scene gives it many sections.

import { NavGrid, RegionGraph } from '@/game/navigation';
import { StructuralModule } from '@/game/destruction';
import type { ModuleId } from '@/game/core/contracts';
import { REGION_ROOM_A, REGION_ROOM_B, type CellXY, type TestBlock } from '@/game/scene';

const MODULE_ID = 1 as ModuleId;
const FRACTURE_FAMILY = 0;
const CELL_STRENGTH = 100;

interface BenchSceneSpec {
  readonly worldVersion: string;
  readonly widthCells: number;
  readonly heightCells: number;
  readonly playerCell: CellXY;
  readonly spawnCenterCell: CellXY;
  /** Cells blocked at authoring time (perimeter walls, interior partitions). */
  readonly blocked: readonly CellXY[];
  /** Destructible wall column: which nav column it occupies + the section rows it owns. */
  readonly wall: {
    readonly cx: number;
    readonly sectionStartCy: number;
    readonly sectionCells: number;
  };
}

/** Shared TestBlock assembly from a declarative spec (the only place nav/region/module are wired). */
function assemble(spec: BenchSceneSpec): TestBlock {
  const navGrid = new NavGrid({ width: spec.widthCells, height: spec.heightCells });
  const region = new RegionGraph();
  region.addRegion(REGION_ROOM_A);
  region.addRegion(REGION_ROOM_B);

  for (const c of spec.blocked) navGrid.block(c.cx, c.cy);

  const wall = new StructuralModule({
    id: MODULE_ID,
    sizeX: 1,
    sizeY: 1,
    sizeZ: spec.wall.sectionCells,
    seed: 7,
  });
  for (let z = 0; z < spec.wall.sectionCells; z++) {
    wall.addCell({ x: 0, y: 0, z, material: 'brick', family: FRACTURE_FAMILY, strength: CELL_STRENGTH });
    // Each destructible section starts blocked (intact) so breaching it opens a route (V5/V18).
    navGrid.block(spec.wall.cx, spec.wall.sectionStartCy + z);
  }

  const navCellSize = navGrid.settings.navCellSize;
  return {
    navGrid,
    region,
    wall,
    moduleId: MODULE_ID,
    worldVersion: spec.worldVersion,
    fractureFamily: FRACTURE_FAMILY,
    playerCell: spec.playerCell,
    spawnCenterCell: spec.spawnCenterCell,
    buildingBounds: { minCx: 0, maxCx: spec.widthCells - 1, minCy: 0, maxCy: spec.heightCells - 1 },
    exitCells: [],
    cellCenter: (cell) => ({ x: (cell.cx + 0.5) * navCellSize, y: 0, z: (cell.cy + 0.5) * navCellSize }),
    navCellForStructuralCell: (structuralCell) => {
      const { z } = wall.unpackCell(structuralCell);
      return { cx: spec.wall.cx, cy: spec.wall.sectionStartCy + z };
    },
    navIndex: (cell) => navGrid.index(cell.cx, cell.cy),
    isWalkableWorld: (x, z) => {
      const { cx, cy } = navGrid.worldToCell(x, z);
      if (cx < 0 || cy < 0 || cx >= navGrid.width || cy >= navGrid.height) return false;
      return !navGrid.isBlocked(navGrid.index(cx, cy));
    },
  };
}

/** Walled rectangle perimeter (the outer shell) as a list of blocked cells. */
function perimeter(w: number, h: number): CellXY[] {
  const out: CellXY[] = [];
  for (let cx = 0; cx < w; cx++) {
    out.push({ cx, cy: 0 });
    out.push({ cx, cy: h - 1 });
  }
  for (let cy = 1; cy < h - 1; cy++) {
    out.push({ cx: 0, cy });
    out.push({ cx: w - 1, cy });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Crowd avenue — a long open street. Player at the near end, the horde scattered down the avenue, one
// shared flow field pulling them toward the player while gunfire rings out.
// ---------------------------------------------------------------------------------------------------
export function buildCrowdAvenue(): TestBlock {
  const w = 100; // 200 m long
  const h = 14; // 28 m wide
  return assemble({
    worldVersion: 'bench-crowd-avenue-1',
    widthCells: w,
    heightCells: h,
    playerCell: { cx: 4, cy: 7 },
    spawnCenterCell: { cx: 70, cy: 7 },
    blocked: perimeter(w, h),
    // inert corner wall (not breached in this scene); kept off every path.
    wall: { cx: 1, sectionStartCy: 1, sectionCells: 1 },
  });
}

// ---------------------------------------------------------------------------------------------------
// Breach cascade — two rooms split by a destructible wall column with MANY sections. The horde is sealed
// in room A; the harness breaches one section per cadence, dirtying local nav tiles + invalidating the
// shared flow field each time (V5/V18).
// ---------------------------------------------------------------------------------------------------
export const BREACH_SECTION_CELLS = 10;

export function buildBreachCascade(): TestBlock {
  const w = 60;
  const h = 18;
  const wallCx = 30;
  const sectionStartCy = 4;
  const blocked = perimeter(w, h);
  // full solid dividing column (the destructible sections inside it are blocked by assemble()).
  for (let cy = 1; cy < h - 1; cy++) {
    if (cy < sectionStartCy || cy >= sectionStartCy + BREACH_SECTION_CELLS) blocked.push({ cx: wallCx, cy });
  }
  return assemble({
    worldVersion: 'bench-breach-cascade-1',
    widthCells: w,
    heightCells: h,
    playerCell: { cx: 50, cy: 9 },
    spawnCenterCell: { cx: 12, cy: 9 },
    blocked,
    wall: { cx: wallCx, sectionStartCy, sectionCells: BREACH_SECTION_CELLS },
  });
}

// ---------------------------------------------------------------------------------------------------
// Dense interior — a partitioned multi-room building. Vertical partitions with staggered doorway gaps
// force the flow field through a maze of narrow openings (queueing/compression, V19); the player sits in
// the far room taking close-quarters fire.
// ---------------------------------------------------------------------------------------------------
export function buildDenseInterior(): TestBlock {
  const w = 44;
  const h = 28;
  const blocked = perimeter(w, h);
  // four interior partition columns; each leaves a 2-cell doorway, staggered top/bottom so the path winds.
  const partitionCols = [9, 18, 27, 36];
  for (let i = 0; i < partitionCols.length; i++) {
    const cx = partitionCols[i]!;
    const doorAtTop = i % 2 === 0;
    const doorStart = doorAtTop ? 2 : h - 4;
    for (let cy = 1; cy < h - 1; cy++) {
      if (cy >= doorStart && cy < doorStart + 2) continue; // doorway gap
      blocked.push({ cx, cy });
    }
  }
  return assemble({
    worldVersion: 'bench-dense-interior-1',
    widthCells: w,
    heightCells: h,
    playerCell: { cx: 40, cy: 14 },
    spawnCenterCell: { cx: 4, cy: 14 },
    blocked,
    wall: { cx: 1, sectionStartCy: 1, sectionCells: 1 },
  });
}

// ---------------------------------------------------------------------------------------------------
// Streaming sprint — a long, wide open grid. The player starts at the near edge and sprints across the
// whole map (crossing many nav-tile / sector boundaries); the horde starts mid-map and tracks the moving
// target, forcing repeated flow-field recomputes as the target cell migrates.
// ---------------------------------------------------------------------------------------------------
export function buildStreamingSprint(): TestBlock {
  const w = 120; // 240 m
  const h = 24; // 48 m
  return assemble({
    worldVersion: 'bench-streaming-sprint-1',
    widthCells: w,
    heightCells: h,
    playerCell: { cx: 4, cy: 12 },
    spawnCenterCell: { cx: 60, cy: 12 },
    blocked: perimeter(w, h),
    wall: { cx: 1, sectionStartCy: 1, sectionCells: 1 },
  });
}

// ---------------------------------------------------------------------------------------------------
// Corpse accumulation — a broad open arena holding thousands of bodies in the loaded set, exercised with
// repeated save → evict → reload cycles (the persistence serialize/restore path).
// ---------------------------------------------------------------------------------------------------
export function buildCorpseArena(): TestBlock {
  const w = 84;
  const h = 44;
  return assemble({
    worldVersion: 'bench-corpse-arena-1',
    widthCells: w,
    heightCells: h,
    playerCell: { cx: 6, cy: 22 },
    spawnCenterCell: { cx: 42, cy: 22 },
    blocked: perimeter(w, h),
    wall: { cx: 1, sectionStartCy: 1, sectionCells: 1 },
  });
}

// ---------------------------------------------------------------------------------------------------
// Mobile capability — same open-avenue shape as crowd avenue but smaller, driven at the mobile tier so
// the runtime resolves the 20 Hz tick + reduced flow-field cache (capability scaling, V25).
// ---------------------------------------------------------------------------------------------------
export function buildMobileAvenue(): TestBlock {
  const w = 80;
  const h = 14;
  return assemble({
    worldVersion: 'bench-mobile-avenue-1',
    widthCells: w,
    heightCells: h,
    playerCell: { cx: 4, cy: 7 },
    spawnCenterCell: { cx: 52, cy: 7 },
    blocked: perimeter(w, h),
    wall: { cx: 1, sectionStartCy: 1, sectionCells: 1 },
  });
}
