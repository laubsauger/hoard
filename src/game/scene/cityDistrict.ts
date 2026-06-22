// T40 — M2 representative DISTRICT authored content. A larger authored block than the M1 city block: a
// walkable street wraps a multi-room building split into a HORDE-HELD interior (left) and the player's
// staging area (right), divided by a solid wall whose only interior connection is the destructible
// StructuralModule section — the DECISIVE-EVENT route the horde floods (or is stalled at) depending on
// what the player did to those cells (§G central promise). The right side has a permanent street door
// (the evacuation EXIT). Several streaming SECTORS are laid over the district; offscreen sectors hold an
// abstract horde population that promotes to live sim as the player traverses (V13).
//
// Satisfies the SAME TestBlock contract as the M1 block, so GameRuntime + BlockScene drive/render it
// unchanged. Geometry is authored level content (cell counts) per the V4 note; the sector COUNT comes
// from typed world config so it stays in sync with the DistrictModel.

import { NavGrid, RegionGraph } from '@/game/navigation';
import { StructuralModule } from '@/game/destruction';
import type { ModuleId } from '@/game/core/contracts';
import { resolveDomain } from '@/config/registry';
import { worldConfig } from '@/config/domains/world';
import type { QualityTier } from '@/config/types';
import type { SectorDescriptor } from '@/game/world';
import {
  REGION_ROOM_A,
  REGION_ROOM_B,
  type CellXY,
  type TestBlock,
} from './testBlock';

/** Region id for the open-air street wrapping the district building (shared with the M1 block). */
export const REGION_STREET = 2;

export const CITY_DISTRICT_WORLD_VERSION = 'm2-citydistrict-1';

// ---- authored layout (nav cells) ---- (navCellSize is 2 m, so ~150 m × 66 m of district)
const GRID_WIDTH_CELLS = 75;
const GRID_HEIGHT_CELLS = 33;

// Building shell (inclusive); everything outside is open-air street.
const B_MIN_CX = 4;
const B_MAX_CX = 70;
const B_MIN_CY = 4;
const B_MAX_CY = 28;

const IN_MIN_CY = B_MIN_CY + 1;
const IN_MAX_CY = B_MAX_CY - 1;

// Solid dividing wall between the horde-held left interior and the player's right staging area.
const WALL_CX = 38;
// The destructible section (the decisive route) spans these interior rows; the rest of the column is permanent.
const WALL_SECTION_CY_START = 14;
const WALL_SECTION_CELLS = 4; // cy 14,15,16,17 — the four climax routes the player can shape

// Evacuation door: a gap in the building's RIGHT perimeter wall opening the player's area to the street.
const DOOR_CX = B_MAX_CX;
const DOOR_CY_START = 15;
const DOOR_CELLS = 2;

const TEST_MODULE_ID = 1 as ModuleId;
const FRACTURE_FAMILY = 0;

const PLAYER_CELL: CellXY = { cx: 54, cy: 16 }; // right staging area centre
const SPAWN_CENTER_CELL: CellXY = { cx: 20, cy: 16 }; // left horde-held interior centre

function isDoorCell(cx: number, cy: number): boolean {
  return cx === DOOR_CX && cy >= DOOR_CY_START && cy < DOOR_CY_START + DOOR_CELLS;
}

/** The district scene plus the streaming sectors laid over it (consumed by DistrictModel). */
export interface CityDistrict {
  readonly block: TestBlock;
  readonly sectors: SectorDescriptor[];
}

/**
 * Lay a districtSectorsX × districtSectorsZ grid of streaming-sector anchors over the building interior.
 * Centres are world-space (sector anchors for activation distance), evenly distributed across the shell.
 */
function buildSectors(navCellSize: number, tier: QualityTier): SectorDescriptor[] {
  const w = resolveDomain(worldConfig, tier);
  const sectors: SectorDescriptor[] = [];
  let id = 0;
  for (let j = 0; j < w.districtSectorsZ; j++) {
    for (let i = 0; i < w.districtSectorsX; i++) {
      const cx = B_MIN_CX + Math.round(((i + 0.5) / w.districtSectorsX) * (B_MAX_CX - B_MIN_CX));
      const cy = B_MIN_CY + Math.round(((j + 0.5) / w.districtSectorsZ) * (B_MAX_CY - B_MIN_CY));
      sectors.push({ id: id++, centerX: (cx + 0.5) * navCellSize, centerZ: (cy + 0.5) * navCellSize });
    }
  }
  return sectors;
}

/**
 * Build a fresh BASE district (immutable authored geometry). Reload reconstructs this and re-applies the
 * compact delta on top (V9) — the base is never persisted, only re-built here.
 */
export function buildCityDistrict(tier: QualityTier = 'desktop-high'): CityDistrict {
  const navGrid = new NavGrid({ width: GRID_WIDTH_CELLS, height: GRID_HEIGHT_CELLS });
  const region = new RegionGraph();
  region.addRegion(REGION_ROOM_A);
  region.addRegion(REGION_ROOM_B);
  region.addRegion(REGION_STREET);

  // Building perimeter walls (skip the evacuation door on the right wall).
  for (let cx = B_MIN_CX; cx <= B_MAX_CX; cx++) {
    navGrid.block(cx, B_MIN_CY);
    navGrid.block(cx, B_MAX_CY);
  }
  for (let cy = B_MIN_CY; cy <= B_MAX_CY; cy++) {
    navGrid.block(B_MIN_CX, cy);
    if (!isDoorCell(B_MAX_CX, cy)) navGrid.block(B_MAX_CX, cy);
  }

  // Solid dividing wall across the interior. The destructible section starts blocked (intact); breaching
  // it opens the horde route from the left interior to the player's staging area.
  for (let cy = IN_MIN_CY; cy <= IN_MAX_CY; cy++) {
    navGrid.block(WALL_CX, cy);
  }

  const wall = new StructuralModule({ id: TEST_MODULE_ID, sizeX: 1, sizeY: 1, sizeZ: WALL_SECTION_CELLS, seed: 7531 });
  for (let z = 0; z < WALL_SECTION_CELLS; z++) {
    wall.addCell({ x: 0, y: 0, z, material: 'brick', family: FRACTURE_FAMILY, strength: 100 });
  }

  const exitCells: CellXY[] = [];
  for (let i = 0; i < DOOR_CELLS; i++) exitCells.push({ cx: DOOR_CX, cy: DOOR_CY_START + i });
  region.addPortal(REGION_ROOM_B, REGION_STREET, navGrid.index(DOOR_CX, DOOR_CY_START), 1);

  const navCellSize = navGrid.settings.navCellSize;

  const block: TestBlock = {
    navGrid,
    region,
    wall,
    moduleId: TEST_MODULE_ID,
    worldVersion: CITY_DISTRICT_WORLD_VERSION,
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

  return { block, sectors: buildSectors(navCellSize, tier) };
}
