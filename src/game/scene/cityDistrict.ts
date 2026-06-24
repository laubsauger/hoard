// T80 / P0b — a LARGE authored multi-building suburban DISTRICT (Project-Zomboid scale). A street grid
// (asphalt + sidewalks + grass verges) carries a block of residential LOTS; MANY separately-enterable houses
// sit on those lots. Each house is now generated from a single-storey floor-plan TEMPLATE (placeHouse —
// docs/PROCEDURAL-HOUSES.md): a real room layout with a sealed exterior shell, a front door onto the street,
// interior partition walls between typed rooms, and windows derived from the room plan. The player roams the
// whole network; the cutaway reveals the interior of whichever building they occupy (per-building roof fade).
//
// The destructible §G test-wall that used to BISECT a house is GONE — real houses are room-based, not a
// two-room breach puzzle. The breach MECHANIC stays available: a single standalone StructuralModule wall
// section sits on the central green so the horde-event routes (which read the module's per-cell breach/
// reinforce/burning state, not its nav position) keep working — without an embedded test wall in a home.
//
// Still returns { block, sectors } satisfying the (extended) TestBlock contract, so GameRuntime + BlockScene
// drive/render it unchanged. Layout is authored level content (cell counts) per V4; tunable scales come from
// typed world config. Determinism (V26): the per-lot template choice + placement is a pure hash of the lot.

import { NavGrid, RegionGraph } from '@/game/navigation';
import { StructuralModule } from '@/game/destruction';
import { setPropSolid } from './propSolidity';
import { furnishHouse } from './furnishHouse';
import { setFurnitureSolid } from './furnitureSolidity';
import type { ModuleId } from '@/game/core/contracts';
import { resolveDomain } from '@/config/registry';
import { worldConfig } from '@/config/domains/world';
import type { QualityTier } from '@/config/types';
import type { SectorDescriptor } from '@/game/world';
import {
  REGION_ROOM_A,
  REGION_ROOM_B,
  type CellXY,
  type ExitCell,
  type CellRect,
  type BuildingFootprint,
  type GroundRect,
  type PropInstance,
  type PlacedFurniture,
  type TestBlock,
} from './testBlock';
import { placeHouse, type PlacedHouse } from './placeHouse';
import { HOUSE_TEMPLATES, type HouseTemplate, type RoomType, type Edge } from './houseTemplates';
import { houseStyleForBuilding, type WindowPlacement } from './windows';
import { resolveHouseVariation, windowState, type HouseVariationParams } from './houseStyle';

/** Region id for the open-air street/yard network wrapping the houses (shared with the M1 block). */
export const REGION_STREET = 2;

export const CITY_DISTRICT_WORLD_VERSION = 'm2-citydistrict-2';

// ---- district grid layout (nav cells; navCellSize is 2 m) -------------------------------------------
// A regular block of COLS×ROWS lots, separated (and bordered) by STREET-wide bands. One lot is an open
// green (the horde muster). A house's nav footprint is EXACTLY its template W×D ROOM cells — there is NO
// exterior wall ring. The exterior walls are THIN edge-walls on the outer faces of the perimeter room cells
// (setWallBetween against the open street, the same model as interior partitions), so the building bounds
// are W×D and the interior floor reaches the outer wall with no gap. They fit inside one LOT_W×LOT_H lot.
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

/** Lot that hosts the player's start house (kept SHELTERED: front door starts closed, no horde inside). */
const PLAYER_COL = 0;
const PLAYER_ROW = 0;

const TEST_MODULE_ID = 1 as ModuleId;
const FRACTURE_FAMILY = 0;
const WALL_SECTION_CELLS = 4; // the standalone breach-mechanic wall — 4 destructible cells

// ---- deterministic per-lot variation ----------------------------------------------------------------
/** Small deterministic hash → [0,1) so the same lot always authors the same house (replay-stable, V26). */
function lotRand(i: number, j: number, salt: number): number {
  let h = (Math.imul(i + 1, 73856093) ^ Math.imul(j + 1, 19349663) ^ Math.imul(salt + 1, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x85ebca6b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The single-storey templates the district draws from (multi-floor colonial is P3 — excluded). Ordered for
 *  a stable index space; the per-lot choice hashes into this list (V26). */
const SINGLE_STOREY_TEMPLATES: readonly HouseTemplate[] = HOUSE_TEMPLATES.filter((t) => t.storeys === 1);

/** Pick a believable, deterministic template for a lot, varying across the street. The player lot gets a
 *  fixed compact template (a small bungalow) so the sheltered start is consistent. */
function templateForLot(i: number, j: number): HouseTemplate {
  if (i === PLAYER_COL && j === PLAYER_ROW) {
    return SINGLE_STOREY_TEMPLATES.find((t) => t.id === 'bungalow-2bed') ?? SINGLE_STOREY_TEMPLATES[0]!;
  }
  const n = SINGLE_STOREY_TEMPLATES.length;
  const idx = Math.min(n - 1, Math.floor(lotRand(i, j, 11) * n));
  return SINGLE_STOREY_TEMPLATES[idx]!;
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
  readonly exitCells: ExitCell[];
  readonly houses: PlacedHouse[];
  readonly furniture: PlacedFurniture[];
  readonly windowSeeds: WindowPlacement[];
  readonly houseVar: HouseVariationParams;
  readonly boardedFraction: number;
  /** Picked when stamping the player's house — the interior cell the player starts in (sheltered). */
  playerCell: CellXY | null;
}

/** A sheltered player-start cell: the interior-edge MIDPOINT on the side OPPOSITE the front door (so the
 *  start is deep from the closed door, yet an edge-midpoint, not a corner — leaving the lootable corner clear
 *  of both the player and the door). */
function shelteredPlayerCell(originCx: number, originCy: number, w: number, d: number, doorDir: Edge): CellXY {
  const midX = originCx + Math.floor((w - 1) / 2);
  const midY = originCy + Math.floor((d - 1) / 2);
  switch (doorDir) {
    case 'n':
      return { cx: midX, cy: originCy + d - 1 }; // door north → start at the south edge
    case 's':
      return { cx: midX, cy: originCy };
    case 'e':
      return { cx: originCx, cy: midY }; // door east → start at the west edge
    case 'w':
      return { cx: originCx + w - 1, cy: midY };
  }
}

const DIRS: readonly Edge[] = ['n', 's', 'e', 'w'];

/** The open-street cell one step OUT from a room cell in `dir` — the OUTER side of an exterior edge-wall
 *  (and the neighbour a front-door / window edge is shared with). */
function ringCellFor(cx: number, cy: number, dir: Edge): CellXY {
  switch (dir) {
    case 'n':
      return { cx, cy: cy - 1 };
    case 's':
      return { cx, cy: cy + 1 };
    case 'e':
      return { cx: cx + 1, cy };
    case 'w':
      return { cx: cx - 1, cy };
  }
}

/**
 * Stamp ONE templated house onto a lot. The footprint is EXACTLY the template's W×D ROOM cells (building bounds
 * W×D, no exterior ring) centred in the lot. EVERY cell is walkable, room-tagged floor — the interior reaches
 * the outer wall with no gap.
 *
 * Both the exterior walls AND the interior partitions are REAL nav collision as EDGE-walls (the PZ model): a
 * wall on the shared edge between two cells, set via `setWallBetween`, blocks crossing + LOS + sound while BOTH
 * cells stay walkable. Exterior: every perimeter room-cell OUTER face (neighbour outside the footprint) is
 * walled against the open street. Interior: each interior `wallEdge` between two rooms is walled, EXCEPT door
 * openings (left clear so the doorway is passable). The FRONT door is a cleared exterior EDGE (an edge-door):
 * left WALLED for the player's house (closed → sheltered start), cleared for every other house. Windows are
 * exterior EDGES flagged for the window system; the edge stays walled (V26 sealed) — windows govern occlusion/
 * render, not nav. Mutates `b`.
 */
function stampTemplatedHouse(b: DistrictBuild, i: number, j: number): void {
  const lot = lotOrigin(i, j);
  const template = templateForLot(i, j);
  const { w, d } = template.footprint;
  // Footprint = the W×D ROOM cells (no exterior wall ring). Centre it in the lot; the building bounds ARE the
  // room cells, so the perimeter cells are walkable floor with thin exterior edge-walls on their outer faces.
  const originCx = lot.minCx + Math.max(0, Math.floor((LOT_W - w) / 2));
  const originCy = lot.minCy + Math.max(0, Math.floor((LOT_H - d) / 2));
  const bMinCx = originCx;
  const bMinCy = originCy;
  const bMaxCx = originCx + w - 1;
  const bMaxCy = originCy + d - 1;

  const placed = placeHouse(template, originCx, originCy);
  const houseIndex = b.houses.length;
  b.houses.push(placed);

  // --- furniture (P1b): furnish every room of this house, in WORLD cells, off a deterministic per-house seed
  // (the placer mixes in each room's type + bounds, so one seed varies layouts per room — V26). SOLID pieces are
  // marked blocked in the nav grid below (after stamping), exactly like prop solidity; the renderer + loot pass
  // read the same list off the scene contract.
  const houseSeed = (Math.imul(originCx + 1, 0x27d4eb2f) ^ Math.imul(originCy + 1, 0x165667b1)) | 0;
  for (const piece of furnishHouse(placed, houseIndex, houseSeed)) b.furniture.push(piece);

  // --- exterior walls as THIN edge-walls: for every perimeter room-cell OUTER face (a footprint-boundary face,
  // i.e. the neighbour one step out is OUTSIDE the room map), wall the shared edge against the open street. Both
  // cells stay walkable; only crossing + LOS + sound are blocked. There is NO sealed cell ring — the footprint
  // cells are the walkable rooms. The FRONT-door edge is cleared below (for non-player houses); window edges +
  // any non-front exterior door edges stay walled.
  for (const rc of placed.rooms) {
    for (const dir of DIRS) {
      const n = ringCellFor(rc.cx, rc.cy, dir);
      if (placed.roomAt(n.cx, n.cy) !== null) continue; // interior neighbour — not an exterior face
      b.navGrid.setWallBetween(rc.cx, rc.cy, n.cx, n.cy, true);
    }
  }

  // --- interior partitions as REAL edge-wall nav (P0 fix): wall every interior wallEdge on the shared edge
  // between its two walkable room cells, EXCEPT the edges that are door openings (left clear so the doorway is
  // passable). Cells stay walkable; only cross-edge movement + LOS are blocked, so the interior subdivides
  // into rooms connected only through doorways.
  const doorEdgeKeys = new Set(placed.doors.map((dr) => dr.edge.key));
  for (const edge of placed.wallEdges) {
    if (edge.kind !== 'interior') continue; // exterior faces are walled above
    if (doorEdgeKeys.has(edge.key)) continue; // a doorway — leave the edge clear (passable)
    if (edge.outerCx === null || edge.outerCy === null) continue; // interior edges always have both sides
    b.navGrid.setWallBetween(edge.innerCx, edge.innerCy, edge.outerCx, edge.outerCy);
  }

  // --- front door: an exterior EDGE-door on the door's room cell. The player's house starts SHELTERED (its door
  // edge left WALLED → closed) so the beelining horde mills at the wall; every other house's door edge is CLEARED
  // (open). exitCells carries the INNER room cell + edgeDir so the runtime builds an edge-door. Only the FRONT
  // door is an exit cell (count == buildings, T80).
  const front = placed.doors.find((dr) => dr.front);
  const isPlayerHouse = i === PLAYER_COL && j === PLAYER_ROW;
  if (front) {
    const outer = ringCellFor(front.cx, front.cy, front.dir);
    if (!isPlayerHouse) b.navGrid.setWallBetween(front.cx, front.cy, outer.cx, outer.cy, false);
    b.exitCells.push({ cx: front.cx, cy: front.cy, edgeDir: front.dir });
    // the player starts DEEP in the house — the interior cell farthest from the (closed) front door — so the
    // start is genuinely sheltered and the lootable corner lands clear of the door.
    if (isPlayerHouse) b.playerCell = shelteredPlayerCell(originCx, originCy, w, d, front.dir);
  }

  // --- windows: each placed window is an exterior EDGE-window. Its edge stays a wall (V26 sealed); occlusion +
  // render state key off the EDGE. The initial decay state is seeded off the per-house style (V26) — render +
  // sim derive the identical state. The world centre is the EDGE midpoint (half a cell out toward `dir`).
  const style = houseStyleForBuilding({ minCx: bMinCx, minCy: bMinCy, maxCx: bMaxCx, maxCy: bMaxCy }, 1, houseIndex, b.houseVar, -1);
  const cs = b.navGrid.settings.navCellSize;
  for (const win of placed.windows) {
    const outer = ringCellFor(win.cx, win.cy, win.dir);
    b.windowSeeds.push({
      cx: win.cx,
      cy: win.cy,
      ns: win.ns,
      slot: win.slot,
      state: windowState(style, win.slot, b.boardedFraction),
      storeys: 1,
      x: ((win.cx + outer.cx + 1) / 2) * cs,
      z: ((win.cy + outer.cy + 1) / 2) * cs,
      edgeDir: win.dir,
    });
  }

  b.buildings.push({ bounds: { minCx: bMinCx, maxCx: bMaxCx, minCy: bMinCy, maxCy: bMaxCy }, storeys: 1 });

  const doorCx = front ? front.cx : lot.minCx + Math.floor(LOT_W / 2);
  dressYard(b, lot, doorCx, i, j);
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

/** The standalone §G breach-mechanic wall: a short 4-cell column on the open green, kept off any house so it
 *  no longer bisects a home. The horde-event routes read the module's per-cell state, so the mechanic stays
 *  whole; nav-wise the cells start blocked (a low garden wall) and a breach clears them. */
const BREACH_WALL_CELLS: readonly CellXY[] = (() => {
  const lot = lotOrigin(PARK_COL, PARK_ROW);
  const cx = lot.minCx + 1;
  const cy0 = lot.minCy + 1;
  return Array.from({ length: WALL_SECTION_CELLS }, (_, z) => ({ cx, cy: cy0 + z }));
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

  const worldCfg = resolveDomain(worldConfig, tier);
  const build: DistrictBuild = {
    navGrid,
    buildings: [],
    groundRects: [],
    props: [],
    exitCells: [],
    houses: [],
    furniture: [],
    windowSeeds: [],
    houseVar: resolveHouseVariation(tier),
    boardedFraction: worldCfg.houseWindowBoardedFraction,
    playerCell: null,
  };

  // ---- ground paint: asphalt base under everything ----
  build.groundRects.push({ kind: 'asphalt', rect: { minCx: 0, maxCx: GRID_WIDTH_CELLS - 1, minCy: 0, maxCy: GRID_HEIGHT_CELLS - 1 } });

  // ---- the houses: every lot is a templated home, except the central green ----
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      if (i === PARK_COL && j === PARK_ROW) {
        stampPark(build, lotOrigin(i, j));
        continue;
      }
      stampTemplatedHouse(build, i, j);
    }
  }

  if (!build.playerCell) throw new Error('district authoring error: the player house produced no front door');
  const playerCell: CellXY = build.playerCell;

  // grass yards on every lot (drawn above the asphalt); sidewalk ring around each lot.
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const lot = lotOrigin(i, j);
      build.groundRects.push({ kind: 'sidewalk', rect: { minCx: lot.minCx - 1, maxCx: lot.maxCx + 1, minCy: lot.minCy - 1, maxCy: lot.maxCy + 1 } });
      build.groundRects.push({ kind: 'grass', rect: { minCx: lot.minCx, maxCx: lot.maxCx, minCy: lot.minCy, maxCy: lot.maxCy } });
    }
  }

  // ---- GENERIC prop solidity (V53/V42/V5): a SOLID prop (car, tree) marks its footprint BLOCKED so shots
  // stop, bodies collide, and sight breaks at it — all via the shared nav grid (no per-asset code). Fence
  // spans block EXCEPT the ones whose decay rolled them missing — using the SAME world chance the renderer
  // reads so blocked cells line up with the visible pickets. Doors are never sealed (guard the exit cells).
  const fenceMissingChance = worldCfg.fenceMissingChance;
  const exitKeys = new Set(build.exitCells.map((e) => navGrid.index(e.cx, e.cy)));
  for (const prop of build.props) {
    setPropSolid(navGrid, prop, true, (cx, cy) => exitKeys.has(navGrid.index(cx, cy)), fenceMissingChance);
  }

  // ---- FURNITURE solidity (P1b): same single-nav-source pattern — a SOLID furniture piece (bed/sofa/counter/
  // fridge/wardrobe/…) marks its footprint BLOCKED so movement + shots + sight all stop at it; low/small pieces
  // stay walkable. The placer guarantees each room keeps a walkable path (furnishRoom flood-fill), and we block
  // only the SOLID subset of pieces, so the room's free space (a superset of the placer's) stays connected — no
  // room is sealed. Door/exit cells are guarded (furniture never lands on them, but skip is belt-and-braces).
  for (const piece of build.furniture) {
    setFurnitureSolid(navGrid, piece, true, (cx, cy) => exitKeys.has(navGrid.index(cx, cy)));
  }

  // ---- the standalone destructible §G wall section (breach mechanic kept; no house bisected) ----
  for (const c of BREACH_WALL_CELLS) navGrid.block(c.cx, c.cy);
  const wall = new StructuralModule({ id: TEST_MODULE_ID, sizeX: 1, sizeY: 1, sizeZ: WALL_SECTION_CELLS, seed: 7531 });
  for (let z = 0; z < WALL_SECTION_CELLS; z++) {
    wall.addCell({ x: 0, y: 0, z, material: 'brick', family: FRACTURE_FAMILY, strength: 100 });
  }

  // coarse region portal: the player's house reaches the street through its front door (opened later).
  const playerFrontGap = build.exitCells[0];
  if (playerFrontGap) region.addPortal(REGION_ROOM_B, REGION_STREET, navGrid.index(playerFrontGap.cx, playerFrontGap.cy), 1);

  // union bbox of every building (back-compat single-rect accessor).
  const buildingBounds = unionBounds(build.buildings.map((bld) => bld.bounds));
  const navCellSize = navGrid.settings.navCellSize;

  // rooms-as-regions lookup (cell → house + room) over every placed house interior (loot/AI, P1).
  const houses = build.houses;
  const roomAt = (cx: number, cy: number): { houseIndex: number; roomId: number; type: RoomType } | null => {
    for (let h = 0; h < houses.length; h++) {
      const r = houses[h]!.roomAt(cx, cy);
      if (r) return { houseIndex: h, roomId: r.roomId, type: r.type };
    }
    return null;
  };

  const block: TestBlock = {
    navGrid,
    region,
    wall,
    moduleId: TEST_MODULE_ID,
    worldVersion: CITY_DISTRICT_WORLD_VERSION,
    fractureFamily: FRACTURE_FAMILY,
    playerCell,
    spawnCenterCell: SPAWN_CENTER_CELL,
    buildingBounds,
    buildings: build.buildings,
    groundRects: build.groundRects,
    props: build.props,
    exitCells: build.exitCells,
    placedHouses: houses,
    placedFurniture: build.furniture,
    windowSeeds: build.windowSeeds,
    roomAt,
    cellCenter: (cell) => ({ x: (cell.cx + 0.5) * navCellSize, y: 0, z: (cell.cy + 0.5) * navCellSize }),
    navCellForStructuralCell: (structuralCell) => {
      const { z } = wall.unpackCell(structuralCell);
      return BREACH_WALL_CELLS[z] ?? BREACH_WALL_CELLS[0]!;
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
