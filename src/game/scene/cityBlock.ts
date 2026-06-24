// T38 — M1 vertical-slice authored content: ONE city block. A walkable street wraps a multi-room
// building. The building has two interior rooms (A left, B right) divided by a solid wall whose ONLY
// interior connection is a destructible StructuralModule section. The player starts in room B, which has
// a permanent door to the street (the ESCAPE exit); the horde starts sealed in room A. Breaching the
// dividing wall (MODIFY) opens a route so the sealed horde streams toward the player (DEFEND) while the
// street door stays open for the player to leave (ESCAPE). Same TestBlock contract as the GATE-0 block,
// so GameRuntime drives it unchanged. Geometry is authored level content (cell counts) per V4 note.

import { NavGrid, RegionGraph } from '@/game/navigation';
import { StructuralModule } from '@/game/destruction';
import type { ModuleId } from '@/game/core/contracts';
import {
  REGION_ROOM_A,
  REGION_ROOM_B,
  type CellXY,
  type TestBlock,
} from './testBlock';

/** Region id for the open-air street wrapping the building. */
export const REGION_STREET = 2;

export const CITY_BLOCK_WORLD_VERSION = 'm1-cityblock-1';

// ---- authored layout (nav cells) ----
// navCellSize is 1 m; every cell-DISTANCE literal is doubled vs the old 2 m grid so the world geometry is
// IDENTICAL in metres (derived offsets like the 1-cell perimeter-wall thickness stay derived).
const GRID_WIDTH_CELLS = 90; // ~90 m at navCellSize 1 m
const GRID_HEIGHT_CELLS = 54; // ~54 m

// Building shell (inclusive) — everything outside this rectangle is open-air street.
const B_MIN_CX = 8;
const B_MAX_CX = 80;
const B_MIN_CY = 8;
const B_MAX_CY = 44;

// Interior walkable band rows (inside the perimeter walls); the dividing wall spans these rows.
const IN_MIN_CY = B_MIN_CY + 1; // 9
const IN_MAX_CY = B_MAX_CY - 1; // 43

// Solid dividing wall between room A and room B.
const WALL_CX = 44;
// The destructible wall section spans these interior rows; the rest of the column is permanent.
const WALL_SECTION_CY_START = 22;
const WALL_SECTION_CELLS = 8; // cy 22..29

// Escape door: a gap in the building's RIGHT perimeter wall, opening room B to the street.
const DOOR_CX = B_MAX_CX; // 80
const DOOR_CY_START = 26;
const DOOR_CELLS = 4; // cy 26..29

const TEST_MODULE_ID = 1 as ModuleId;
const FRACTURE_FAMILY = 0;

const PLAYER_CELL: CellXY = { cx: 62, cy: 26 }; // room B centre
const SPAWN_CENTER_CELL: CellXY = { cx: 26, cy: 26 }; // room A centre

function isDoorCell(cx: number, cy: number): boolean {
  return cx === DOOR_CX && cy >= DOOR_CY_START && cy < DOOR_CY_START + DOOR_CELLS;
}

/**
 * Build a fresh BASE city block (immutable authored geometry). Reload reconstructs this and re-applies
 * the compact delta on top (V9) — the base is never persisted, only re-built here.
 */
export function buildCityBlock(): TestBlock {
  const navGrid = new NavGrid({ width: GRID_WIDTH_CELLS, height: GRID_HEIGHT_CELLS });
  const region = new RegionGraph();
  region.addRegion(REGION_ROOM_A);
  region.addRegion(REGION_ROOM_B);
  region.addRegion(REGION_STREET);

  // Building perimeter walls (skip the escape door on the right wall so room B reaches the street).
  for (let cx = B_MIN_CX; cx <= B_MAX_CX; cx++) {
    navGrid.block(cx, B_MIN_CY);
    navGrid.block(cx, B_MAX_CY);
  }
  for (let cy = B_MIN_CY; cy <= B_MAX_CY; cy++) {
    navGrid.block(B_MIN_CX, cy);
    if (!isDoorCell(B_MAX_CX, cy)) navGrid.block(B_MAX_CX, cy);
  }

  // Solid dividing wall across the interior. The destructible section starts blocked too (intact);
  // breaching it later clears those cells and opens the room A <-> room B route.
  for (let cy = IN_MIN_CY; cy <= IN_MAX_CY; cy++) {
    navGrid.block(WALL_CX, cy);
  }

  // The destructible section as a sparse StructuralModule: 1 wide (x), 1 tall (y), N deep (z).
  const wall = new StructuralModule({ id: TEST_MODULE_ID, sizeX: 1, sizeY: 1, sizeZ: WALL_SECTION_CELLS, seed: 4242 });
  for (let z = 0; z < WALL_SECTION_CELLS; z++) {
    wall.addCell({ x: 0, y: 0, z, material: 'brick', family: FRACTURE_FAMILY, strength: 100 });
  }

  const exitCells: CellXY[] = [];
  for (let i = 0; i < DOOR_CELLS; i++) exitCells.push({ cx: DOOR_CX, cy: DOOR_CY_START + i });
  // Room B reaches the street through the door (region connectivity; nav reachability is via navGrid).
  region.addPortal(REGION_ROOM_B, REGION_STREET, navGrid.index(DOOR_CX, DOOR_CY_START), 1);

  const navCellSize = navGrid.settings.navCellSize;

  const block: TestBlock = {
    navGrid,
    region,
    wall,
    moduleId: TEST_MODULE_ID,
    worldVersion: CITY_BLOCK_WORLD_VERSION,
    fractureFamily: FRACTURE_FAMILY,
    playerCell: PLAYER_CELL,
    spawnCenterCell: SPAWN_CENTER_CELL,
    buildingBounds: { minCx: B_MIN_CX, maxCx: B_MAX_CX, minCy: B_MIN_CY, maxCy: B_MAX_CY },
    exitCells,
    cellCenter: (cell) => ({ x: (cell.cx + 0.5) * navCellSize, y: 0, z: (cell.cy + 0.5) * navCellSize }),
    navCellForStructuralCell: (structuralCell) => {
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
