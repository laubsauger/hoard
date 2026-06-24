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
  /** Whether this prop kind is a solid obstacle (blocks shots + movement via the nav grid). */
  readonly solid: boolean;
  /** Half-extent (METRES) along the prop's LENGTH — its local +Z, the long axis of the mesh (e.g. a car body). */
  readonly halfLenMeters: number;
  /** Half-extent (METRES) along the prop's WIDTH — its local +X, the short axis. */
  readonly halfWidMeters: number;
  /**
   * Approximate occluder HEIGHT (m). SIGHT (eye-height LOS) is blocked only by a prop at/above eye height; a
   * prop SHORTER than eye height is SEEN OVER (a waist-high picket fence). Movement + projectile occlusion are
   * unaffected (those use `solid` on the nav grid) — height only governs the see-over sight gap (V85).
   */
  readonly heightMeters: number;
}

/** Per-kind solidity, sized to the MESH footprint in METRES (resolution-independent — it rasterizes into the
 *  grid's navCellSize cells, so the SAME physical car blocks the same metres whether navCellSize is 2 m or 1 m).
 *  A car body is ~4.2 m long × ~1.8 m wide, oriented by the prop's `rot`. Tall dense obstacles are solid;
 *  low/soft decor (tire, bush) is shoot-over cover and gappy fences stay non-blocking so a single span never
 *  seals a yard (their look is purely render). Half-extents reproduce the OLD 2 m-grid footprint and auto-scale:
 *  e.g. a car at navCellSize 2 m rasterizes to ~3 cells long × 1 wide (as before), at 1 m to ~5 × 1. */
export const PROP_SOLIDITY: Readonly<Record<PropKind, PropSolidity>> = {
  car: { solid: true, halfLenMeters: 2.1, halfWidMeters: 0.9, heightMeters: 1.6 }, // ~4.2 m long × 1.8 m wide; tall enough to block sight (cover)
  tree: { solid: true, halfLenMeters: 0.5, halfWidMeters: 0.5, heightMeters: 4 }, // the trunk — one cell; a tall canopy blocks sight
  tire: { solid: false, halfLenMeters: 0.5, halfWidMeters: 0.5, heightMeters: 0.5 }, // low — you shoot/step/see over it
  bush: { solid: false, halfLenMeters: 0.5, halfWidMeters: 0.5, heightMeters: 0.8 }, // soft, low cover
  fence: { solid: true, halfLenMeters: 0.5, halfWidMeters: 0.5, heightMeters: 1.0 }, // a picket span (one cell) blocks bodies/shots — but is WAIST-HIGH, so sight passes OVER it (V85)
};

/** A fence span is PRESENT (solid) unless its deterministic decay rolled it MISSING — the EXACT decision the
 *  renderer makes (propsBuilder: `hash01(seed, 5000) < fenceMissingChance`), so blocked cells match the visible
 *  pickets and a rendered GAP stays walkable. Same seed formula as the render. */
function fencePresent(prop: PropInstance, fenceMissingChance: number): boolean {
  const seed = (Math.imul(prop.cx + 1, 73856093) ^ Math.imul(prop.cy + 1, 19349663)) | 0;
  return hash01(seed, 5000) >= fenceMissingChance;
}

/** The nav cells a SOLID prop occupies — its mesh-sized METRE rectangle, ROTATED by the prop's `rot`, rasterized
 *  into the grid's `navCellSize` cells (so a parked car blocks a car-shaped strip, not a fat square, at any nav
 *  resolution). A cell is included iff its CENTRE falls inside the rotated rectangle. Empty for non-solid kinds.
 *  A fence span blocks only when PRESENT (its decay roll didn't make it a gap) — pass the world
 *  `fenceMissingChance` so it matches the render. Pure + deterministic; the scene generator marks these blocked,
 *  callers clamp to grid bounds. */
export function propBlockedCells(
  prop: PropInstance,
  navCellSize: number,
  fenceMissingChance = 0,
): { cx: number; cy: number }[] {
  const s = PROP_SOLIDITY[prop.kind];
  if (!s.solid) return [];
  if (prop.kind === 'fence' && !fencePresent(prop, fenceMissingChance)) return []; // missing span → a walkable gap
  const rot = prop.rot ?? 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  // Cell reach to scan: the rectangle's diagonal half-extent, converted to cells (+1 for the centre offset).
  const reach = Math.ceil(Math.hypot(s.halfLenMeters, s.halfWidMeters) / navCellSize) + 1;
  const cells: { cx: number; cy: number }[] = [];
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      // world offset (m) of this candidate cell's centre from the prop cell's centre (the +0.5 centres cancel).
      const ox = dx * navCellSize;
      const oy = dy * navCellSize;
      // rotate the world offset back into the prop's local frame (inverse of the rot used by the renderer).
      const localX = ox * cos - oy * sin; // local +X = width
      const localZ = ox * sin + oy * cos; // local +Z = length
      if (Math.abs(localX) <= s.halfWidMeters && Math.abs(localZ) <= s.halfLenMeters) {
        cells.push({ cx: prop.cx + dx, cy: prop.cy + dy });
      }
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
  for (const cell of propBlockedCells(prop, navGrid.settings.navCellSize, fenceMissingChance)) {
    if (cell.cx < 0 || cell.cy < 0 || cell.cx >= navGrid.width || cell.cy >= navGrid.height) continue;
    if (skip?.(cell.cx, cell.cy)) continue;
    if (solid) navGrid.block(cell.cx, cell.cy);
    else navGrid.clear(cell.cx, cell.cy);
  }
}

/** True iff this prop kind, when solid, occludes SIGHT at `eyeHeightMeters` — i.e. it is at/above eye height.
 *  A solid prop SHORTER than eye height (a waist-high fence) is SEEN OVER, so it is NOT a sight occluder (V85). */
export function propOccludesSight(kind: PropKind, eyeHeightMeters: number): boolean {
  const s = PROP_SOLIDITY[kind];
  return s.solid && s.heightMeters >= eyeHeightMeters;
}

/** The nav cells a SOLID-but-SUB-EYE-HEIGHT prop occupies — it blocks movement/shots (it is `solid` on the nav
 *  grid) but SIGHT passes OVER it. Empty for non-solid props and for tall props (>= eyeHeight, which occlude
 *  sight). Same footprint as `propBlockedCells`. Pure + deterministic — the runtime unions these into the
 *  SEE-OVER set the sight LOS consults so vision clears a low fence while nav/projectiles still stop at it. */
export function propSeeOverCells(
  prop: PropInstance,
  eyeHeightMeters: number,
  navCellSize: number,
  fenceMissingChance = 0,
): { cx: number; cy: number }[] {
  const s = PROP_SOLIDITY[prop.kind];
  if (!s.solid || s.heightMeters >= eyeHeightMeters) return []; // non-solid (no block) or tall (occludes sight)
  return propBlockedCells(prop, navCellSize, fenceMissingChance);
}
