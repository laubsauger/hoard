// T41 — GATE-0 test-block scene (authored content, not engine tuning).
// A two-room interior: room A (left) and room B (right) separated by a solid wall whose ONLY
// connection is a single destructible wall section (a StructuralModule). The player stands in room B;
// the horde spawns in room A. Until the wall is breached the rooms are navigationally disconnected —
// breaching it opens a route, which is the central promise (§G) made measurable.
//
// Geometry is authored level content (cell counts / wall positions), the way destruction.test.ts uses
// literal grid sizes. Genuinely-tunable values (population, spawn extent) are sourced from config by
// the caller and passed in, never hardcoded here (V4).

import { NavGrid } from '@/game/navigation';
import { RegionGraph } from '@/game/navigation';
import { StructuralModule } from '@/game/destruction';
import type { ModuleId } from '@/game/core/contracts';

/** Base-package version this authored block belongs to (save-compat gate on reload — V23). */
export const TEST_BLOCK_WORLD_VERSION = 'gate0-testblock-1';

export const REGION_ROOM_A = 0;
export const REGION_ROOM_B = 1;

/** Authored layout (nav cells). The grid is two 20x20 rooms either side of a one-cell-thick wall. */
const GRID_WIDTH_CELLS = 41; // room A: cx 0..19 | wall: cx 20 | room B: cx 21..40
const GRID_HEIGHT_CELLS = 20;
const WALL_CX = 20;
/** The destructible wall section spans these rows; the rest of the wall column is permanent. */
const WALL_SECTION_CY_START = 8;
const WALL_SECTION_CELLS = 4; // cy 8,9,10,11
const TEST_MODULE_ID = 1 as ModuleId;
const FRACTURE_FAMILY = 0;

/** Player stands in room B; horde spawn-centre sits in room A. (cell coords) */
const PLAYER_CELL: CellXY = { cx: 31, cy: 10 };
const SPAWN_CENTER_CELL: CellXY = { cx: 9, cy: 10 };

export interface CellXY {
  readonly cx: number;
  readonly cy: number;
}

/** Inclusive cell rectangle of the building shell (walls + interior). Cells inside get a roof + cutaway;
 *  cells outside are open-air street. Used purely by the renderer (T38), never by the sim. */
export interface CellRect {
  readonly minCx: number;
  readonly maxCx: number;
  readonly minCy: number;
  readonly maxCy: number;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface TestBlock {
  readonly navGrid: NavGrid;
  readonly region: RegionGraph;
  /** The single destructible wall section connecting room A <-> room B. */
  readonly wall: StructuralModule;
  readonly moduleId: ModuleId;
  readonly worldVersion: string;
  readonly fractureFamily: number;
  /** Player aim/eye position is filled per-runtime using player config aim height. */
  readonly playerCell: CellXY;
  readonly spawnCenterCell: CellXY;
  /** Building shell rectangle (walls + interior) for the renderer's roof + cutaway (T38). */
  readonly buildingBounds: CellRect;
  /** Walkable cells the player can leave the building through (escape route, T38). May be empty. */
  readonly exitCells: readonly CellXY[];
  /** World-space centre of a nav cell (y = 0 floor). */
  cellCenter(cell: CellXY): Vec3;
  /** Map a module-local structural cell to the nav cell it occupies (integrator-owned seam). */
  navCellForStructuralCell(structuralCell: number): CellXY;
  /** Index into the nav cost grid for a cell. */
  navIndex(cell: CellXY): number;
  /** True when a world position lies on an in-bounds, walkable nav cell. */
  isWalkableWorld(x: number, z: number): boolean;
}

/**
 * Radius-aware walkability (T58/V42): a body of radius `r` may occupy (x,z) only if its centre AND its
 * four cardinal rim points are all walkable — so no part of the circle pokes into a wall/closed-door/
 * boarded/obstructed cell. Cheap 5-sample approximation; the integrator rejects or slides on failure so
 * bodies never clip half into a wall. Composes the scene's own `isWalkableWorld` (one source of truth).
 */
export function isWalkableRadius(
  scene: Pick<TestBlock, 'isWalkableWorld'>,
  x: number,
  z: number,
  r: number,
): boolean {
  return (
    scene.isWalkableWorld(x, z) &&
    scene.isWalkableWorld(x + r, z) &&
    scene.isWalkableWorld(x - r, z) &&
    scene.isWalkableWorld(x, z + r) &&
    scene.isWalkableWorld(x, z - r)
  );
}

/**
 * Build a fresh BASE world (immutable authored geometry). Reload reconstructs this and re-applies the
 * compact delta on top (V9) — the base is never persisted, only re-built here.
 */
export function buildTestBlock(): TestBlock {
  const navGrid = new NavGrid({ width: GRID_WIDTH_CELLS, height: GRID_HEIGHT_CELLS });
  const region = new RegionGraph();
  region.addRegion(REGION_ROOM_A);
  region.addRegion(REGION_ROOM_B);

  // Solid dividing wall: block the whole wall column. The destructible section is part of this wall
  // and starts blocked too (intact). Breaching it later clears those cells (opens the route).
  for (let cy = 0; cy < GRID_HEIGHT_CELLS; cy++) {
    navGrid.block(WALL_CX, cy);
  }

  // The destructible wall section as a sparse StructuralModule: 1 wide (x), 1 tall (y), N deep (z).
  const wall = new StructuralModule({
    id: TEST_MODULE_ID,
    sizeX: 1,
    sizeY: 1,
    sizeZ: WALL_SECTION_CELLS,
    seed: 1337,
  });
  for (let z = 0; z < WALL_SECTION_CELLS; z++) {
    wall.addCell({ x: 0, y: 0, z, material: 'brick', family: FRACTURE_FAMILY, strength: 100 });
  }

  const navCellSize = navGrid.settings.navCellSize;

  const block: TestBlock = {
    navGrid,
    region,
    wall,
    moduleId: TEST_MODULE_ID,
    worldVersion: TEST_BLOCK_WORLD_VERSION,
    fractureFamily: FRACTURE_FAMILY,
    playerCell: PLAYER_CELL,
    spawnCenterCell: SPAWN_CENTER_CELL,
    // The bare GATE-0 block is wall-to-wall building: the whole grid is the shell, no street, no exit.
    buildingBounds: { minCx: 0, maxCx: GRID_WIDTH_CELLS - 1, minCy: 0, maxCy: GRID_HEIGHT_CELLS - 1 },
    exitCells: [],
    cellCenter: (cell) => ({
      x: (cell.cx + 0.5) * navCellSize,
      y: 0,
      z: (cell.cy + 0.5) * navCellSize,
    }),
    navCellForStructuralCell: (structuralCell) => {
      // module is 1x1xN so the local index IS the z row; map to the wall column + section offset.
      const { z } = wall.unpackCell(structuralCell);
      return { cx: WALL_CX, cy: WALL_SECTION_CY_START + z };
    },
    navIndex: (cell) => navGrid.index(cell.cx, cell.cy),
    isWalkableWorld: (x, z) => {
      const { cx, cy } = navGrid.worldToCell(x, z);
      if (cx < 0 || cy < 0 || cx >= navGrid.width || cy >= navGrid.height) return false;
      return !navGrid.isBlocked(navGrid.index(cx, cy));
    },
  };
  return block;
}
