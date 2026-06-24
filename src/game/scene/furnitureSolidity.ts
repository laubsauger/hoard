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
// A furniture footprint is authored in the SAME world-cell space the placer emitted (furnishHouse passes world
// room bounds), so a piece's `cell`+`footprint` already are world cells — no rotation needed (unlike a car, whose
// footprint is sized to the mesh and oriented by `rot`). Pure + deterministic (V26).

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

/** The world nav cells a SOLID furniture piece occupies (its footprint). Empty for a non-solid piece. */
export function furnitureBlockedCells(piece: PlacedFurniture): { cx: number; cy: number }[] {
  if (!FURNITURE_SOLIDITY[piece.kind]) return [];
  const cells: { cx: number; cy: number }[] = [];
  for (let dy = 0; dy < piece.footprint.d; dy++) {
    for (let dx = 0; dx < piece.footprint.w; dx++) {
      cells.push({ cx: piece.cx + dx, cy: piece.cy + dy });
    }
  }
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
  for (const cell of furnitureBlockedCells(piece)) {
    if (cell.cx < 0 || cell.cy < 0 || cell.cx >= navGrid.width || cell.cy >= navGrid.height) continue;
    if (skip?.(cell.cx, cell.cy)) continue;
    if (solid) navGrid.block(cell.cx, cell.cy);
    else navGrid.clear(cell.cx, cell.cy);
  }
}
