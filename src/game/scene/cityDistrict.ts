// T80 — a LARGE authored multi-building suburban DISTRICT (Project-Zomboid scale). A street grid (asphalt +
// sidewalks + grass verges) carries a block of residential LOTS; MANY separately-enterable houses sit on
// those lots, each with perimeter walls, a front door onto the street, an interior partition (two rooms),
// windows + porch (rendered from the authored grid), a fenced yard and abandoned-car/tire/overgrowth
// dressing. The player roams the whole network: out a front door, down the sidewalk, into any other house —
// the cutaway reveals the interior of whichever building they currently occupy (per-building roof fade).
//
// ONE house keeps the destructible StructuralModule section (the central promise, §G) — breaching its
// interior dividing wall opens a route between its two rooms — but the world is NOT built around defending
// it: it is one feature among many. The horde gathers in a central green and streams across the grid toward
// the player over the shared flow field; offscreen streaming SECTORS (laid on the open streets) hold the
// abstract population the rest of the world promotes from (V13).
//
// Still returns { block, sectors } and the block satisfies the SAME (extended) TestBlock contract, so
// GameRuntime + BlockScene drive/render it unchanged. Layout is authored level content (cell counts) per
// the V4 note; tunable scales (sector count, abstract pop) come from typed world config.

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
  type CellRect,
  type BuildingFootprint,
  type GroundRect,
  type PropInstance,
  type TestBlock,
} from './testBlock';

/** Region id for the open-air street/yard network wrapping the houses (shared with the M1 block). */
export const REGION_STREET = 2;

export const CITY_DISTRICT_WORLD_VERSION = 'm2-citydistrict-1';

// ---- district grid layout (nav cells; navCellSize is 2 m) -------------------------------------------
// A regular block of COLS×ROWS lots, separated (and bordered) by STREET-wide bands. One lot is an open
// green (the horde muster). Width ≈ 158 m, height ≈ 98 m.
const STREET = 4; // cells (8 m) — street + sidewalk + verge band around every lot
const LOT_W = 11; // cells — lot footprint (house + yard)
const LOT_H = 11;
const COLS = 5;
const ROWS = 3;
const GRID_WIDTH_CELLS = STREET + COLS * (LOT_W + STREET); // 79
const GRID_HEIGHT_CELLS = STREET + ROWS * (LOT_H + STREET); // 49

/** The central lot left open as a green (no house) — the horde musters here and streams outward. */
const PARK_COL = 2;
const PARK_ROW = 1;

const TEST_MODULE_ID = 1 as ModuleId;
const FRACTURE_FAMILY = 0;

// ---- feature house (lot 0,0) — carries the destructible dividing wall (the §G promise) --------------
// Authored explicitly so the StructuralModule maps onto real interior cells. A vertical wall splits it into
// room A (west, sealed) and room B (east, with the street door + player start); the destructible section is
// the middle run of that wall — breaching it is the only route between the rooms.
const FEATURE_H_MIN_CX = 5;
const FEATURE_H_MIN_CY = 5;
const FEATURE_H_W = 9; // 18 m
const FEATURE_H_H = 8; // 16 m
const FEATURE_H_MAX_CX = FEATURE_H_MIN_CX + FEATURE_H_W - 1; // 13
const FEATURE_H_MAX_CY = FEATURE_H_MIN_CY + FEATURE_H_H - 1; // 12
const FEATURE_WALL_CX = 9; // interior dividing wall column
const WALL_SECTION_CY_START = 7;
const WALL_SECTION_CELLS = 4; // cy 7,8,9,10 — the destructible run
const FEATURE_DOOR_CX = 11; // door in room B's south wall
const FEATURE_DOOR_CY = FEATURE_H_MAX_CY; // 12

const PLAYER_CELL: CellXY = { cx: 11, cy: 9 }; // feature-house room B (east), walkable interior

// ---- deterministic per-lot variation ----------------------------------------------------------------
/** Small deterministic hash → [0,1) so the same lot always authors the same house (replay-stable, V26). */
function lotRand(i: number, j: number, salt: number): number {
  let h = (Math.imul(i + 1, 73856093) ^ Math.imul(j + 1, 19349663) ^ Math.imul(salt + 1, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x85ebca6b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface LotOrigin {
  readonly minCx: number;
  readonly minCy: number;
  readonly maxCx: number;
  readonly maxCy: number;
}

function lotOrigin(i: number, j: number): LotOrigin {
  const minCx = STREET + i * (LOT_W + STREET);
  const minCy = STREET + j * (LOT_H + STREET);
  return { minCx, minCy, maxCx: minCx + LOT_W - 1, maxCy: minCy + LOT_H - 1 };
}

/** Build-time accumulators threaded through lot stamping. */
interface DistrictBuild {
  readonly navGrid: NavGrid;
  readonly buildings: BuildingFootprint[];
  readonly groundRects: GroundRect[];
  readonly props: PropInstance[];
  readonly exitCells: CellXY[];
}

/**
 * Stamp one ordinary house into a lot: perimeter walls (with a south front-door gap), a single interior
 * partition (two rooms, with a doorway gap), a fenced front yard, and a little dressing. Footprint + storeys
 * vary deterministically per lot. Returns nothing — mutates the shared build accumulators.
 */
function stampHouse(b: DistrictBuild, i: number, j: number): void {
  const lot = lotOrigin(i, j);
  // footprint 5..7 wide × 4..6 deep (10–14 m × 8–12 m), centred in the lot with a 1-cell north margin.
  const hw = 5 + Math.floor(lotRand(i, j, 1) * 3); // 5..7
  const hh = 4 + Math.floor(lotRand(i, j, 2) * 3); // 4..6
  const hMinCx = lot.minCx + Math.floor((LOT_W - hw) / 2);
  const hMinCy = lot.minCy + 1;
  const hMaxCx = hMinCx + hw - 1;
  const hMaxCy = hMinCy + hh - 1;
  const storeys = lotRand(i, j, 3) < 0.4 ? 2 : 1;
  const doorCx = hMinCx + Math.floor(hw / 2);

  stampShell(b, hMinCx, hMinCy, hMaxCx, hMaxCy, doorCx, hMaxCy);

  // interior partition: a horizontal wall splitting front/back rooms, with a 1-cell doorway gap.
  if (hh >= 5) {
    const partCy = hMinCy + Math.floor(hh / 2);
    const gapCx = hMinCx + 1 + Math.floor(lotRand(i, j, 4) * Math.max(1, hw - 2));
    for (let cx = hMinCx + 1; cx <= hMaxCx - 1; cx++) {
      if (cx === gapCx) continue;
      b.navGrid.block(cx, partCy);
    }
  }

  b.buildings.push({ bounds: { minCx: hMinCx, maxCx: hMaxCx, minCy: hMinCy, maxCy: hMaxCy }, storeys });
  dressYard(b, lot, doorCx, i, j);
}

/** Block a rectangular shell perimeter, leaving the single (cx,cy) cell open as the front door. */
function stampShell(
  b: DistrictBuild,
  minCx: number,
  minCy: number,
  maxCx: number,
  maxCy: number,
  doorCx: number,
  doorCy: number,
): void {
  for (let cx = minCx; cx <= maxCx; cx++) {
    b.navGrid.block(cx, minCy);
    if (!(cx === doorCx && maxCy === doorCy)) b.navGrid.block(cx, maxCy);
  }
  for (let cy = minCy; cy <= maxCy; cy++) {
    b.navGrid.block(minCx, cy);
    b.navGrid.block(maxCx, cy);
  }
  if (doorCy === maxCy) b.exitCells.push({ cx: doorCx, cy: doorCy });
}

/** Fence the lot's street frontage (south + short side returns), leaving the door's walk open, plus a few
 *  yard props (tree/bush/tire) and an occasional abandoned car on the street out front. */
function dressYard(b: DistrictBuild, lot: LotOrigin, doorCx: number, i: number, j: number): void {
  // front (south) picket fence with a gap aligned to the door walk
  for (let cx = lot.minCx; cx <= lot.maxCx; cx++) {
    if (cx === doorCx) continue;
    b.props.push({ kind: 'fence', cx, cy: lot.maxCy, rot: 0 });
  }
  // short side returns at the front corners
  for (let k = 0; k < 2; k++) {
    b.props.push({ kind: 'fence', cx: lot.minCx, cy: lot.maxCy - k, rot: Math.PI / 2 });
    b.props.push({ kind: 'fence', cx: lot.maxCx, cy: lot.maxCy - k, rot: Math.PI / 2 });
  }
  // yard tree + bush
  if (lotRand(i, j, 5) < 0.7) {
    b.props.push({ kind: 'tree', cx: lot.minCx + 1, cy: lot.minCy + 1, variant: Math.floor(lotRand(i, j, 6) * 3) });
  }
  b.props.push({ kind: 'bush', cx: lot.maxCx - 1, cy: lot.minCy + 1, variant: Math.floor(lotRand(i, j, 7) * 3) });
  // abandoned car on the street directly south of the lot (every other lot, deterministic)
  if (lotRand(i, j, 8) < 0.45) {
    b.props.push({ kind: 'car', cx: doorCx, cy: lot.maxCy + 2, rot: 0, variant: Math.floor(lotRand(i, j, 9) * 3) });
  }
  if (lotRand(i, j, 10) < 0.3) {
    b.props.push({ kind: 'tire', cx: lot.minCx + 2, cy: lot.maxCy - 1 });
  }
}

/** Leave the central lot an open overgrown green: scattered trees/bushes, a wreck, broken fencing. */
function stampPark(b: DistrictBuild, lot: LotOrigin): void {
  b.props.push({ kind: 'car', cx: lot.minCx + 7, cy: lot.minCy + 7, rot: 0.6, variant: 2 });
  for (let k = 0; k < 5; k++) {
    const cx = lot.minCx + 1 + ((k * 5 + 1) % LOT_W);
    const cy = lot.minCy + 1 + ((k * 3 + 2) % LOT_H);
    b.props.push({ kind: k % 2 === 0 ? 'tree' : 'bush', cx, cy, variant: k % 3 });
  }
  b.props.push({ kind: 'tire', cx: lot.minCx + 3, cy: lot.minCy + 8 });
  b.props.push({ kind: 'tire', cx: lot.minCx + 4, cy: lot.minCy + 8 });
}

/** The horde musters in the central green. */
const SPAWN_CENTER_CELL: CellXY = (() => {
  const lot = lotOrigin(PARK_COL, PARK_ROW);
  return { cx: Math.floor((lot.minCx + lot.maxCx) / 2), cy: Math.floor((lot.minCy + lot.maxCy) / 2) };
})();

/** The district scene plus the streaming sectors laid over it (consumed by DistrictModel). */
export interface CityDistrict {
  readonly block: TestBlock;
  readonly sectors: SectorDescriptor[];
}

/**
 * Lay streaming-sector anchors on OPEN street rows (guaranteed walkable full-width corridors) so the
 * promoted abstract population always scatters onto clear ground (V13). districtSectorsX × districtSectorsZ
 * from typed world config (V4), spread across the populated district.
 */
function buildSectors(navGrid: NavGrid, navCellSize: number, tier: QualityTier): SectorDescriptor[] {
  const w = resolveDomain(worldConfig, tier);
  // rows entirely free of house cells (the asphalt bands) — robust open anchors for the spawn scatter.
  const openRows: number[] = [];
  for (let cy = 0; cy < GRID_HEIGHT_CELLS; cy++) {
    let open = true;
    for (let cx = 0; cx < GRID_WIDTH_CELLS && open; cx++) {
      if (navGrid.isBlocked(navGrid.index(cx, cy))) open = false;
    }
    if (open) openRows.push(cy);
  }
  if (openRows.length === 0) throw new Error('district has no open street row for sector anchors (content error)');
  const sectors: SectorDescriptor[] = [];
  let id = 0;
  for (let j = 0; j < w.districtSectorsZ; j++) {
    const rowIdx = Math.min(openRows.length - 1, Math.round(((j + 0.5) / w.districtSectorsZ) * openRows.length));
    const cy = openRows[rowIdx] as number;
    for (let i = 0; i < w.districtSectorsX; i++) {
      const cx = 3 + Math.round(((i + 0.5) / w.districtSectorsX) * (GRID_WIDTH_CELLS - 6));
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

  const build: DistrictBuild = { navGrid, buildings: [], groundRects: [], props: [], exitCells: [] };

  // ---- ground paint: asphalt base, grass lots, concrete sidewalk rings ----
  build.groundRects.push({ kind: 'asphalt', rect: { minCx: 0, maxCx: GRID_WIDTH_CELLS - 1, minCy: 0, maxCy: GRID_HEIGHT_CELLS - 1 } });

  // ---- the feature house (destructible dividing wall) on lot (0,0) ----
  stampShell(build, FEATURE_H_MIN_CX, FEATURE_H_MIN_CY, FEATURE_H_MAX_CX, FEATURE_H_MAX_CY, FEATURE_DOOR_CX, FEATURE_DOOR_CY);
  // the dividing wall column (interior rows) — starts fully intact (blocked); the section breaches open.
  for (let cy = FEATURE_H_MIN_CY + 1; cy <= FEATURE_H_MAX_CY - 1; cy++) navGrid.block(FEATURE_WALL_CX, cy);
  // The player's house starts SHELTERED: close (block) its front door so the beelining horde can't path
  // straight into the player's room — it mills at the walls instead, so the player can observe + test the
  // idle->attack trigger rather than being swarmed at spawn. Breaching the dividing wall / a door opens it.
  navGrid.block(FEATURE_DOOR_CX, FEATURE_DOOR_CY);
  build.buildings.push({
    bounds: { minCx: FEATURE_H_MIN_CX, maxCx: FEATURE_H_MAX_CX, minCy: FEATURE_H_MIN_CY, maxCy: FEATURE_H_MAX_CY },
    storeys: 2,
  });
  dressYard(build, lotOrigin(0, 0), FEATURE_DOOR_CX, 0, 0);

  // ---- the remaining lots: ordinary enterable houses, except the central green ----
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      if (i === 0 && j === 0) continue; // feature house already placed
      if (i === PARK_COL && j === PARK_ROW) {
        stampPark(build, lotOrigin(i, j));
        continue;
      }
      stampHouse(build, i, j);
    }
  }

  // grass yards on every lot (drawn above the asphalt); sidewalk ring around each lot.
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const lot = lotOrigin(i, j);
      build.groundRects.push({ kind: 'sidewalk', rect: { minCx: lot.minCx - 1, maxCx: lot.maxCx + 1, minCy: lot.minCy - 1, maxCy: lot.maxCy + 1 } });
      build.groundRects.push({ kind: 'grass', rect: { minCx: lot.minCx, maxCx: lot.maxCx, minCy: lot.minCy, maxCy: lot.maxCy } });
    }
  }

  // ---- the destructible StructuralModule section (the §G promise) ----
  const wall = new StructuralModule({ id: TEST_MODULE_ID, sizeX: 1, sizeY: 1, sizeZ: WALL_SECTION_CELLS, seed: 7531 });
  for (let z = 0; z < WALL_SECTION_CELLS; z++) {
    wall.addCell({ x: 0, y: 0, z, material: 'brick', family: FRACTURE_FAMILY, strength: 100 });
  }

  // feature-house room B reaches the street through its front door (region connectivity).
  region.addPortal(REGION_ROOM_B, REGION_STREET, navGrid.index(FEATURE_DOOR_CX, FEATURE_DOOR_CY), 1);

  // union bbox of every building (back-compat single-rect accessor).
  const buildingBounds = unionBounds(build.buildings.map((b) => b.bounds));
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
    buildingBounds,
    buildings: build.buildings,
    groundRects: build.groundRects,
    props: build.props,
    exitCells: build.exitCells,
    cellCenter: (cell) => ({ x: (cell.cx + 0.5) * navCellSize, y: 0, z: (cell.cy + 0.5) * navCellSize }),
    navCellForStructuralCell: (structuralCell) => {
      const { z } = wall.unpackCell(structuralCell);
      return { cx: FEATURE_WALL_CX, cy: WALL_SECTION_CY_START + z };
    },
    navIndex: (cell) => navGrid.index(cell.cx, cell.cy),
    isWalkableWorld: (x, z) => {
      const { cx, cy } = navGrid.worldToCell(x, z);
      if (cx < 0 || cy < 0 || cx >= navGrid.width || cy >= navGrid.height) return false;
      return !navGrid.isBlocked(navGrid.index(cx, cy));
    },
  };

  return { block, sectors: buildSectors(navGrid, navCellSize, tier) };
}

function unionBounds(rects: readonly CellRect[]): CellRect {
  let minCx = Infinity;
  let minCy = Infinity;
  let maxCx = -Infinity;
  let maxCy = -Infinity;
  for (const r of rects) {
    minCx = Math.min(minCx, r.minCx);
    minCy = Math.min(minCy, r.minCy);
    maxCx = Math.max(maxCx, r.maxCx);
    maxCy = Math.max(maxCy, r.maxCy);
  }
  return { minCx, minCy, maxCx, maxCy };
}
