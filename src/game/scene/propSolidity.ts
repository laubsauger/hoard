// T-props / V53 / V42 — GENERIC prop solidity. A scene authors many decorative props (cars, trees, …); the
// SOLID ones must occlude shots, block movement, and break line of sight — without combat/movement/perception
// code special-casing each asset. The single source of truth is the PROP_SOLIDITY map below: at scene build,
// every solid prop's footprint cells are marked BLOCKED in the nav grid. Because the firearm occlusion query
// (firstProjectileBlockerDistance, V53/B20), the radius-aware movement collision (V42), and the structural
// line-of-sight all read the SAME nav grid, one registration makes a prop stop bullets + bodies + sight at
// once. To make a new prop solid, add a row here — no other code changes.

import type { NavGrid } from '@/game/navigation';
import { hash01 } from './houseStyle';
import type { PropInstance, PropKind } from './testBlock';

export interface PropSolidity {
  /** Whether this prop kind is a solid obstacle (blocks shots + movement + sight via the nav grid). */
  readonly solid: boolean;
  /** Half-extent (cells) along the prop's LENGTH — its local +Z, the long axis of the mesh (e.g. a car body). */
  readonly halfLenCells: number;
  /** Half-extent (cells) along the prop's WIDTH — its local +X, the short axis. */
  readonly halfWidCells: number;
}

/** Per-kind solidity, sized to the MESH footprint (not a fat square): a car body is BoxGeometry(2 wide × 4.2
 *  long), so on a 2 m nav grid it is ~1 cell wide × ~3 cells long — NOT a 6×6 block. The footprint is oriented
 *  by the prop's `rot`. Tall dense obstacles are solid; low/soft decor (tire, bush) is shoot-over cover and gappy
 *  fences stay non-blocking so a single span never seals a yard (their look is purely render). */
export const PROP_SOLIDITY: Readonly<Record<PropKind, PropSolidity>> = {
  car: { solid: true, halfLenCells: 1, halfWidCells: 0 }, // ~4.2 m long × 2 m wide → 3 cells long, 1 wide
  tree: { solid: true, halfLenCells: 0, halfWidCells: 0 }, // the trunk — one cell
  tire: { solid: false, halfLenCells: 0, halfWidCells: 0 }, // low — you shoot/step over it
  bush: { solid: false, halfLenCells: 0, halfWidCells: 0 }, // soft, low cover
  fence: { solid: true, halfLenCells: 0, halfWidCells: 0 }, // a picket span blocks — EXCEPT missing spans (gaps), see below
};

/** A fence span is PRESENT (solid) unless its deterministic decay rolled it MISSING — the EXACT decision the
 *  renderer makes (propsBuilder: `hash01(seed, 5000) < fenceMissingChance`), so blocked cells match the visible
 *  pickets and a rendered GAP stays walkable. Same seed formula as the render. */
function fencePresent(prop: PropInstance, fenceMissingChance: number): boolean {
  const seed = (Math.imul(prop.cx + 1, 73856093) ^ Math.imul(prop.cy + 1, 19349663)) | 0;
  return hash01(seed, 5000) >= fenceMissingChance;
}

/** The nav cells a SOLID prop occupies — a rectangle sized to the mesh and ROTATED by the prop's `rot` (so a
 *  parked car blocks a car-shaped strip, not a fat square). Empty for non-solid kinds. A fence span blocks only
 *  when PRESENT (its decay roll didn't make it a gap) — pass the world `fenceMissingChance` so it matches the
 *  render. Pure + deterministic; the scene generator marks these blocked, callers clamp to grid bounds. */
export function propBlockedCells(prop: PropInstance, fenceMissingChance = 0): { cx: number; cy: number }[] {
  const s = PROP_SOLIDITY[prop.kind];
  if (!s.solid) return [];
  if (prop.kind === 'fence' && !fencePresent(prop, fenceMissingChance)) return []; // missing span → a walkable gap
  const rot = prop.rot ?? 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const seen = new Set<number>();
  const cells: { cx: number; cy: number }[] = [];
  for (let dz = -s.halfLenCells; dz <= s.halfLenCells; dz++) {
    for (let dx = -s.halfWidCells; dx <= s.halfWidCells; dx++) {
      // local (dx = width/+X, dz = length/+Z) rotated about +Y by `rot`, snapped to the nearest cell.
      const cx = prop.cx + Math.round(dx * cos + dz * sin);
      const cy = prop.cy + Math.round(-dx * sin + dz * cos);
      const key = cx * 100003 + cy;
      if (seen.has(key)) continue;
      seen.add(key);
      cells.push({ cx, cy });
    }
  }
  return cells;
}

/**
 * Apply (or remove) a prop's solidity to the LIVE nav grid via V5 LOCAL EDITS — the single mechanism that keeps
 * nav in sync with a CHANGING world (barricades, destroyed/added props). Each footprint cell is block()/clear()ed,
 * which marks ONLY the owning tile dirty + bumps navRevision; flow fields + pathing key off navRevision so they
 * rebuild after the change, and a chunked rebuild consumes the dirty tiles. Runs identically at scene build
 * (solid=true) and at runtime (e.g. solid=false when a car is cleared, or true when a barricade is raised).
 *
 * SAFE because solid props occupy OPEN ground only (street/yard) — disjoint from structural wall/door cells —
 * so clearing a prop cell never re-opens a wall (structures own + mutate their own cells). `skip` lets a caller
 * protect specific cells (e.g. never seal a doorway). Out-of-bounds cells are ignored.
 */
export function setPropSolid(
  navGrid: NavGrid,
  prop: PropInstance,
  solid: boolean,
  skip?: (cx: number, cy: number) => boolean,
  fenceMissingChance = 0,
): void {
  for (const cell of propBlockedCells(prop, fenceMissingChance)) {
    if (cell.cx < 0 || cell.cy < 0 || cell.cx >= navGrid.width || cell.cy >= navGrid.height) continue;
    if (skip?.(cell.cx, cell.cy)) continue;
    if (solid) navGrid.block(cell.cx, cell.cy);
    else navGrid.clear(cell.cx, cell.cy);
  }
}
