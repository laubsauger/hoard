// P1b — FURNITURE SOLIDITY. The exact sibling of propSolidity.ts (cars/trees) for INTERIOR furniture: the SOLID
// pieces (big/tall — bed, sofa, counters, fridge, wardrobe, …) mark their footprint cells BLOCKED in the nav
// grid so they stop bullets, bodies, and sight via the ONE shared nav source (the firearm occlusion query, the
// radius-aware movement collision V42, and structural LOS all read the same grid — one registration blocks all
// three). The SOLID set covers everything a person physically cannot walk through: anything that reaches the
// floor at waist/chest height (so also nightstand, armchair, sink, toilet, console — these are knee-to-chest
// boxes you'd bump into, not step over). LOW / FLAT pieces (coffeeTable, tv on a low stand, chair) and the
// WALL-MOUNTED medicineCabinet (hangs above head height — you walk under it) stay non-blocking. To change a
// kind's solidity, edit the map below; no other code.
//
// The nav block is the piece's ACTUAL MESH footprint (FURNITURE_FOOTPRINT_METERS, in metres), centred on the
// piece's render position and oriented by `facing`, then rasterized to cells — exactly like propSolidity. It is
// NOT the reserved cell box the placer used (that over-blocked: a thin 1.0×0.4 m bookshelf was sealing a whole
// 2×2 m of floor). Pure + deterministic (V26).

import type { NavGrid } from '@/game/navigation';
import type { FurnitureKind } from './furnishRoom';
import type { PlacedFurniture } from './testBlock';

/** Per-kind solidity. SOLID = a big/tall obstacle (blocks movement + shots + sight); the rest are low/small and
 *  stay walkable (an agent steps around/over them). Mirrors PROP_SOLIDITY's single-source-of-truth structure. */
export const FURNITURE_SOLIDITY: Readonly<Record<FurnitureKind, boolean>> = {
  // --- solid: big / tall pieces ---
  bed: true,
  dresser: true,
  wardrobe: true,
  sofa: true,
  bookshelf: true,
  diningTable: true,
  sideboard: true,
  counter: true,
  stove: true,
  fridge: true,
  bathtub: true,
  workbench: true,
  shelving: true,
  washer: true,
  gunCabinet: true, // T139: a tall steel locker — solid
  // waist/chest-height boxes that reach the floor — a body can't pass through them.
  nightstand: true,
  armchair: true,
  sink: true,
  toilet: true,
  console: true,
  // --- non-solid: low / flat / wall-mounted pieces (step around / over / walk under) ---
  coffeeTable: false,
  tv: false,
  chair: false,
  medicineCabinet: false,
};

/** Whether a furniture kind is a solid nav obstacle. */
export function isFurnitureSolid(kind: FurnitureKind): boolean {
  return FURNITURE_SOLIDITY[kind];
}

/**
 * Per-kind MESH footprint (metres, width × depth in the piece's LOCAL frame — w along local +x, d along local
 * +z/front). This MUST match the body part dimensions in furnitureBuilder.KIND_PARTS so the nav block matches
 * what's drawn — a piece blocks exactly the cells its mesh actually covers, not a fat reserved cell box (a
 * bookshelf is 1.0 × 0.4 m, NOT a 2 × 2 m slab). Mirrors PROP_SOLIDITY's meter footprint: resolution-independent,
 * so it stays correct at any navCellSize.
 */
export const FURNITURE_FOOTPRINT_METERS: Readonly<Record<FurnitureKind, { w: number; d: number }>> = {
  bed: { w: 1.4, d: 1.9 },
  nightstand: { w: 0.5, d: 0.5 },
  dresser: { w: 1.0, d: 0.5 },
  wardrobe: { w: 1.0, d: 0.6 },
  sofa: { w: 1.6, d: 0.8 },
  armchair: { w: 0.8, d: 0.8 },
  bookshelf: { w: 1.0, d: 0.4 },
  diningTable: { w: 1.4, d: 1.0 },
  sideboard: { w: 1.4, d: 0.5 },
  counter: { w: 1.04, d: 0.64 },
  stove: { w: 1.0, d: 0.6 },
  sink: { w: 0.62, d: 0.62 },
  fridge: { w: 0.9, d: 0.7 },
  bathtub: { w: 1.7, d: 0.8 },
  workbench: { w: 1.6, d: 0.7 },
  shelving: { w: 1.0, d: 0.5 },
  washer: { w: 0.7, d: 0.7 },
  gunCabinet: { w: 0.7, d: 0.5 }, // T139: a narrow tall locker
  toilet: { w: 0.5, d: 0.6 },
  console: { w: 1.0, d: 0.35 },
  // non-solid pieces (never blocked) — footprints kept for completeness / future use.
  coffeeTable: { w: 1.0, d: 0.6 },
  tv: { w: 0.8, d: 0.4 },
  chair: { w: 0.45, d: 0.45 },
  medicineCabinet: { w: 0.5, d: 0.18 },
};

/**
 * The world nav cells a SOLID furniture piece occupies — its ACTUAL MESH footprint (FURNITURE_FOOTPRINT_METERS),
 * centred on the piece's render position and oriented by `facing`, rasterized to the grid (a cell is blocked iff
 * its CENTRE lies inside the footprint rect — the same rule propSolidity uses). At least the centre cell blocks
 * (a piece smaller than one cell is still an obstacle). Empty for a non-solid piece. Pure + deterministic (V26).
 */
export function furnitureBlockedCells(piece: PlacedFurniture, navCellSize: number): { cx: number; cy: number }[] {
  if (!FURNITURE_SOLIDITY[piece.kind]) return [];
  const cs = navCellSize;
  const fp = FURNITURE_FOOTPRINT_METERS[piece.kind];
  // The mesh is drawn at the CENTRE of the piece's reserved footprint cells (furnitureBuilder), so block around
  // that same centre — independent of how many cells the placement reserved.
  const centerX = (piece.cx + piece.footprint.w / 2) * cs;
  const centerZ = (piece.cy + piece.footprint.d / 2) * cs;
  // facing n/s → the mesh's width runs along world X, depth along Z; facing e/w rotates it 90° (width along Z).
  const alongX = piece.facing === 'n' || piece.facing === 's';
  const halfX = (alongX ? fp.w : fp.d) / 2;
  const halfZ = (alongX ? fp.d : fp.w) / 2;
  const cells: { cx: number; cy: number }[] = [];
  const minCx = Math.floor((centerX - halfX) / cs);
  const maxCx = Math.floor((centerX + halfX) / cs);
  const minCy = Math.floor((centerZ - halfZ) / cs);
  const maxCy = Math.floor((centerZ + halfZ) / cs);
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const ccx = (cx + 0.5) * cs;
      const ccz = (cy + 0.5) * cs;
      if (Math.abs(ccx - centerX) <= halfX && Math.abs(ccz - centerZ) <= halfZ) cells.push({ cx, cy });
    }
  }
  if (cells.length === 0) cells.push({ cx: Math.floor(centerX / cs), cy: Math.floor(centerZ / cs) }); // ≥ centre cell
  return cells;
}

/**
 * Apply (or remove) a furniture piece's solidity to the LIVE nav grid via V5 LOCAL EDITS — identical mechanism
 * to setPropSolid: each footprint cell is block()/clear()ed (marks the owning tile dirty + bumps navRevision so
 * flow fields + pathing rebuild). `skip` protects specific cells (e.g. a doorway / exit cell) so furniture can
 * never seal a doorway. Out-of-bounds cells are ignored. Non-solid pieces are a no-op.
 */
export function setFurnitureSolid(
  navGrid: NavGrid,
  piece: PlacedFurniture,
  solid: boolean,
  skip?: (cx: number, cy: number) => boolean,
): void {
  for (const cell of furnitureBlockedCells(piece, navGrid.settings.navCellSize)) {
    if (cell.cx < 0 || cell.cy < 0 || cell.cx >= navGrid.width || cell.cy >= navGrid.height) continue;
    if (skip?.(cell.cx, cell.cy)) continue;
    if (solid) navGrid.block(cell.cx, cell.cy);
    else navGrid.clear(cell.cx, cell.cy);
  }
}
