// P1a — pure, deterministic FURNITURE PLACEMENT for typed rooms (procedural-houses, docs/PROCEDURAL-HOUSES.md).
//
// This is DATA + PLACEMENT ONLY. No three/GPU, no NavGrid, no sim wiring — fully unit-testable headless. Given a
// room (type + cell bounds + which boundary edges are exterior / have windows / carry doors) and a seed, it
// returns a believable, grounded furniture layout: which pieces, where (cell + facing), their footprint, and
// which pieces are LOOT CONTAINERS (each with a `LootSource` the future loot pass seeds). It is the LAYOUT
// SOURCE that P1b (render meshes) and P1c (nav-block + loot seeding) consume — the output schema is shaped so
// they can read footprints (nav blockers) and `container` (loot) straight off each piece.
//
// COORDINATES. Cells are (cx, cy) in the SAME space as the supplied `bounds` (the caller passes either a
// template's footprint-relative room rect from houseTemplates.ts, or a PlacedHouse's WORLD room rect — this
// module is space-agnostic: it never assumes an origin, only that every output cell lies inside `bounds`).
// `cy` increases SOUTHWARD ("down" the plan), matching houseTemplates. Edges: 'n' = -cy, 's' = +cy, 'e' = +cx,
// 'w' = -cx. A piece's `facing` is the direction its FRONT points; a wall piece's back is to its wall, so it
// faces the OPPOSITE of its wall edge (into the room). `footprint {w,d}` is axis-aligned in cell space (w along
// +cx, d along +cy), INDEPENDENT of `facing`.
//
// GRID. On the coarse 2 m nav grid (navCellSize = 2 m/cell, ~6.5 ft) one "piece" occupies ONE cell here:
// footprints are 1x1. That is a deliberate coarse first pass — finer sub-cell furniture (a nightstand tucked
// beside a bed, chairs hugging a table, a counter run spanning a half-cell lip) can layer on in P1b without
// changing this schema: the validator + consumers already handle footprints > 1 cell, only the generator emits
// 1x1 for now.
//
// DETERMINISM (V26). Same (seed, room) ⇒ identical layout; a different seed MAY differ. No Math.random — every
// choice is a `hash01(effSeed, salt)` draw off the seeded hash stream in ./houseStyle. The seed is mixed with
// the room's type + bounds (`effSeed`) so a caller can pass ONE house seed for every room and still get varied
// per-room layouts.

import { hash01 } from './houseStyle';
import type { Cell, CellRect, Edge, RoomType } from './houseTemplates';
import type { LootSource } from '@/game/inventory/loot';

// ---------------------------------------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------------------------------------

/** Every furniture piece kind the placer can emit. */
export type FurnitureKind =
  | 'bed'
  | 'nightstand'
  | 'dresser'
  | 'wardrobe'
  | 'sofa'
  | 'armchair'
  | 'coffeeTable'
  | 'tv'
  | 'bookshelf'
  | 'diningTable'
  | 'chair'
  | 'sideboard'
  | 'counter'
  | 'sink'
  | 'stove'
  | 'fridge'
  | 'toilet'
  | 'bathtub'
  | 'medicineCabinet'
  | 'workbench'
  | 'shelving'
  | 'washer'
  | 'gunCabinet'
  | 'console';

/**
 * A single placed furniture piece.
 * - `cell` — the piece's anchor cell (its NW / min corner), in the same coord space as the room `bounds`.
 * - `footprint` — axis-aligned size in cells (w along +cx, d along +cy); the piece covers
 *   `cx..cx+w-1` x `cy..cy+d-1`. 1x1 on the coarse grid (see header).
 * - `facing` — the direction the FRONT faces. Wall pieces face into the room (opposite their wall edge).
 * - `container` — the `LootSource` this piece is searched as, or `null` for a non-container piece.
 */
export interface FurniturePiece {
  readonly kind: FurnitureKind;
  readonly cell: { readonly cx: number; readonly cy: number };
  readonly footprint: { readonly w: number; readonly d: number };
  readonly facing: Edge;
  readonly container: LootSource | null;
}

/** A window on one of the room's exterior boundary edges — pins a (cell, edge) a TALL piece must not block. */
export interface RoomWindow {
  readonly edge: Edge;
  readonly cell: Cell;
}

/** Inputs to {@link furnishRoom}: the room + its openings + a seed. */
export interface FurnishRoomArgs {
  readonly type: RoomType;
  /** Inclusive cell rectangle the room occupies (template- or world-space; output cells stay inside it). */
  readonly bounds: CellRect;
  /** Seed for the deterministic layout (mixed with the room's type + bounds — see header). */
  readonly seed: number;
  /** Door-opening cells inside this room — never furnished, and their access is kept walkable. */
  readonly doorCells: readonly Cell[];
  /** Windows on the room's exterior walls — a tall piece won't back onto a (cell, edge) carrying one. */
  readonly windows: readonly RoomWindow[];
  /** Which of the room's four boundary edges face OUTSIDE the footprint (windows may only sit on these). */
  readonly exteriorEdges: readonly Edge[];
  /**
   * Edge length (in cells) of each emitted piece's square footprint. 1 on the coarse first pass; the scene sets
   * it to SUBDIV when it stamps SUBDIVIDED houses, so a piece stays ≈2 m (2×2 fine cells at navCellSize 1 m).
   * Wall pieces back onto a boundary with the whole footprint in-bounds; the placer keeps the room path clear.
   */
  readonly footprintCells?: number | undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Per-room-type furniture programs (the grounded sets). Order matters: must-have / container pieces come FIRST
// so they win the room's wall space before fillers. Counts are the list lengths (no magic numbers — read the
// program). `placement: 'wall'` ⇒ backs onto a room-boundary wall (big pieces); `'free'` ⇒ free-standing in the
// room interior (tables, chairs, armchair). `tall` ⇒ must NOT block a window (a low piece under a window is OK).
// ---------------------------------------------------------------------------------------------------------

interface PieceSpec {
  readonly kind: FurnitureKind;
  readonly container: LootSource | null;
  readonly placement: 'wall' | 'free';
  readonly tall: boolean;
}

const wall = (kind: FurnitureKind, container: LootSource | null = null, tall = false): PieceSpec => ({
  kind,
  container,
  placement: 'wall',
  tall,
});
const free = (kind: FurnitureKind, container: LootSource | null = null): PieceSpec => ({
  kind,
  container,
  placement: 'free',
  tall: false,
});

// CONTAINER → LootSource mapping (reusing the EXISTING loot.ts sources — no new sources invented):
//   kitchen fridge        → 'kitchen'    bedroom dresser  → 'bedroom'    bedroom wardrobe → 'wardrobe'
//   bathroom medicineCab. → 'bathroom'   garage shelving  → 'garage'     closet shelving  → 'wardrobe'
//   laundry washer        → 'wardrobe'   laundry shelving → 'garage'
//   living bookshelf      → 'bedroom'  (no 'living' source exists; 'bedroom' is the closest general-household
//                                       table — flashlight/battery/jacket/candy/bandage — so the bookshelf
//                                       reuses it rather than inventing a LootSource)
//   dining sideboard      → 'kitchen'  (a hutch stores dishware/dining goods → closest existing is 'kitchen')
const PROGRAMS: Record<RoomType, readonly PieceSpec[]> = {
  kitchen: [
    wall('fridge', 'kitchen', true),
    wall('stove'),
    wall('sink'),
    wall('counter'),
    wall('counter'),
    wall('counter'),
    free('diningTable'),
  ],
  bedroom: [
    wall('bed'),
    wall('dresser', 'bedroom'),
    wall('wardrobe', 'wardrobe', true),
    wall('nightstand'),
  ],
  bathroom: [
    wall('toilet'),
    wall('sink'),
    wall('medicineCabinet', 'bathroom', true),
    wall('bathtub'),
  ],
  living: [
    wall('sofa'),
    wall('bookshelf', 'bedroom', true),
    wall('tv'),
    free('armchair'),
    free('coffeeTable'),
  ],
  dining: [
    free('diningTable'),
    wall('sideboard', 'kitchen'),
    free('chair'),
    free('chair'),
    free('chair'),
    free('chair'),
  ],
  hall: [
    // Circulation space — keep it mostly clear so P1c nav-blocking can't trap an agent. One slim console only.
    wall('console'),
  ],
  garage: [
    // Workbench + shelving along the walls; the centre is left open (a car would sit there / be parked outside).
    wall('workbench'),
    wall('shelving', 'garage', true),
    wall('shelving', 'garage', true),
    // T139: a locked GUN CABINET — the household's firearms + ammo (the only 'gunCabinet' loot source placed, so
    // weapons/ammunition are findable in the world, not just the starter loadout).
    wall('gunCabinet', 'gunCabinet', true),
  ],
  closet: [wall('shelving', 'wardrobe', true)],
  laundry: [wall('washer', 'wardrobe'), wall('shelving', 'garage', true)],
};

// ---------------------------------------------------------------------------------------------------------
// Geometry / determinism helpers
// ---------------------------------------------------------------------------------------------------------

const OPPOSITE: Record<Edge, Edge> = { n: 's', s: 'n', e: 'w', w: 'e' };
const NEIGHBOUR: Record<Edge, { dx: number; dy: number }> = {
  n: { dx: 0, dy: -1 },
  s: { dx: 0, dy: 1 },
  e: { dx: 1, dy: 0 },
  w: { dx: -1, dy: 0 },
};
/** Stable index of each room type, mixed into the per-room seed so same seed ⇒ varied per-room layouts. */
const ROOM_TYPE_ORDER: readonly RoomType[] = [
  'kitchen',
  'bedroom',
  'bathroom',
  'living',
  'dining',
  'hall',
  'garage',
  'closet',
  'laundry',
];

const key = (cx: number, cy: number): string => `${cx},${cy}`;

/** Mix the caller seed with the room's type + bounds → a per-room integer seed for the hash stream. */
function roomSeed(seed: number, type: RoomType, b: CellRect): number {
  const t = Math.max(0, ROOM_TYPE_ORDER.indexOf(type));
  const rh =
    (Math.imul(b.minCx | 0, 0x1f1f1f1f) ^
      Math.imul(b.minCy | 0, 0x27d4eb2f) ^
      Math.imul(b.maxCx | 0, 0x165667b1) ^
      Math.imul(b.maxCy | 0, 0x2545f491) ^
      Math.imul(t + 1, 0x9e3779b1)) |
    0;
  return (Math.imul(seed | 0, 0x85ebca77) ^ Math.imul(rh, 0xc2b2ae3d)) | 0;
}

/** Every cell of an inclusive rect, row-major (cy outer, cx inner) — a stable deterministic order. */
function rectCells(b: CellRect): Cell[] {
  const out: Cell[] = [];
  for (let cy = b.minCy; cy <= b.maxCy; cy++) {
    for (let cx = b.minCx; cx <= b.maxCx; cx++) out.push({ cx, cy });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Validators (exported — the tests + future consumers reuse them)
// ---------------------------------------------------------------------------------------------------------

/** Cells a piece's footprint covers (anchor cell = min corner, extends +cx / +cy). */
export function pieceCells(piece: FurniturePiece): Cell[] {
  const out: Cell[] = [];
  for (let dy = 0; dy < piece.footprint.d; dy++) {
    for (let dx = 0; dx < piece.footprint.w; dx++) {
      out.push({ cx: piece.cell.cx + dx, cy: piece.cell.cy + dy });
    }
  }
  return out;
}

/**
 * PURE validator (P1c + tests): every piece is in-bounds, no two pieces overlap, and no piece covers a door
 * cell. Footprint-general (handles pieces larger than 1 cell). Returns true iff the whole layout is legal.
 */
export function furnitureFits(
  pieces: readonly FurniturePiece[],
  roomBounds: CellRect,
  doorCells: readonly Cell[],
): boolean {
  const door = new Set(doorCells.map((c) => key(c.cx, c.cy)));
  const occupied = new Set<string>();
  for (const piece of pieces) {
    for (const c of pieceCells(piece)) {
      if (c.cx < roomBounds.minCx || c.cx > roomBounds.maxCx) return false;
      if (c.cy < roomBounds.minCy || c.cy > roomBounds.maxCy) return false;
      const k = key(c.cx, c.cy);
      if (door.has(k)) return false; // never furnish a doorway
      if (occupied.has(k)) return false; // overlap
      occupied.add(k);
    }
  }
  return true;
}

/**
 * PATH-CLEAR validator (the "a door is never sealed" guarantee): a flood-fill from a door cell over the
 * NON-FURNITURE cells of the room reaches every other non-furniture cell. So the door's cell and the whole
 * walkable remainder of the room are one connected region — no piece can wall an agent out of (or into) a
 * doorway. With no door cells, floods from the first free cell (still proves the free space is one blob).
 */
export function furnitureLeavesPathClear(
  pieces: readonly FurniturePiece[],
  roomBounds: CellRect,
  doorCells: readonly Cell[],
): boolean {
  const occupied = new Set<string>();
  for (const piece of pieces) for (const c of pieceCells(piece)) occupied.add(key(c.cx, c.cy));
  const freeCells = rectCells(roomBounds).filter((c) => !occupied.has(key(c.cx, c.cy)));
  if (freeCells.length === 0) return true;
  const freeSet = new Set(freeCells.map((c) => key(c.cx, c.cy)));
  // Prefer a door cell as the flood source (doors are never furnished, so they are always free).
  const startCell = doorCells.find((c) => freeSet.has(key(c.cx, c.cy))) ?? freeCells[0]!;
  const seen = new Set<string>([key(startCell.cx, startCell.cy)]);
  const stack: Cell[] = [startCell];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const e of ['n', 's', 'e', 'w'] as Edge[]) {
      const d = NEIGHBOUR[e];
      const nk = key(cur.cx + d.dx, cur.cy + d.dy);
      if (freeSet.has(nk) && !seen.has(nk)) {
        seen.add(nk);
        stack.push({ cx: cur.cx + d.dx, cy: cur.cy + d.dy });
      }
    }
  }
  return seen.size === freeCells.length;
}

// ---------------------------------------------------------------------------------------------------------
// The placer
// ---------------------------------------------------------------------------------------------------------

interface Candidate {
  readonly cx: number;
  readonly cy: number;
  readonly facing: Edge;
}

/** Would occupying `cand`'s f×f footprint keep every still-free cell (incl. doors) in one connected region? */
function stillConnected(
  occupied: Set<string>,
  cand: Candidate,
  f: number,
  b: CellRect,
  doorCells: readonly Cell[],
): boolean {
  const trial = new Set(occupied);
  for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) trial.add(key(cand.cx + dx, cand.cy + dy));
  const freeCells = rectCells(b).filter((c) => !trial.has(key(c.cx, c.cy)));
  if (freeCells.length === 0) return true;
  const freeSet = new Set(freeCells.map((c) => key(c.cx, c.cy)));
  const start = doorCells.find((c) => freeSet.has(key(c.cx, c.cy))) ?? freeCells[0]!;
  const seen = new Set<string>([key(start.cx, start.cy)]);
  const stack: Cell[] = [start];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const e of ['n', 's', 'e', 'w'] as Edge[]) {
      const d = NEIGHBOUR[e];
      const nk = key(cur.cx + d.dx, cur.cy + d.dy);
      if (freeSet.has(nk) && !seen.has(nk)) {
        seen.add(nk);
        stack.push({ cx: cur.cx + d.dx, cy: cur.cy + d.dy });
      }
    }
  }
  return seen.size === freeCells.length;
}

/**
 * Place a believable, grounded furniture layout for one typed room. Pure + deterministic (V26). Returns the
 * pieces; every piece is in-bounds, non-overlapping, never on a door cell, and the layout keeps a walkable path
 * (see {@link furnitureLeavesPathClear}). Big pieces back onto walls (facing into the room); tall pieces avoid
 * windows; freestanding pieces (tables/chairs) face the room centre.
 */
export function furnishRoom(args: FurnishRoomArgs): FurniturePiece[] {
  const { type, bounds, doorCells, windows, exteriorEdges } = args;
  const f = args.footprintCells ?? 1;
  if (!Number.isInteger(f) || f < 1) throw new Error(`furnishRoom: footprintCells must be a positive integer, got ${f}`);
  const effSeed = roomSeed(args.seed, type, bounds);

  // Input validation (not a fallback — surfaces a malformed call): windows must sit on EXTERIOR edges.
  const exterior = new Set(exteriorEdges);
  for (const win of windows) {
    if (!exterior.has(win.edge)) {
      throw new Error(`furnishRoom: window edge '${win.edge}' is not an exterior edge of the ${type} room`);
    }
  }

  const centreCx = (bounds.minCx + bounds.maxCx) / 2;
  const centreCy = (bounds.minCy + bounds.maxCy) / 2;
  const doorSet = new Set(doorCells.map((c) => key(c.cx, c.cy)));
  const windowSet = new Set(windows.map((w) => `${w.cell.cx},${w.cell.cy}|${w.edge}`));
  const occupied = new Set<string>();
  const pieces: FurniturePiece[] = [];

  /** Direction a free-standing piece faces: toward the room centre (its dominant axis), default 's'. */
  const faceCentre = (cx: number, cy: number): Edge => {
    const dx = centreCx - cx;
    const dy = centreCy - cy;
    if (Math.abs(dx) >= Math.abs(dy)) {
      if (dx > 0) return 'e';
      if (dx < 0) return 'w';
    }
    if (dy < 0) return 'n';
    return 's';
  };

  const cells = rectCells(bounds);

  /** The f×f footprint anchored at (ax, ay) fits inside the room bounds. */
  const footprintInBounds = (ax: number, ay: number): boolean =>
    ax >= bounds.minCx && ay >= bounds.minCy && ax + f - 1 <= bounds.maxCx && ay + f - 1 <= bounds.maxCy;
  /** Every cell of the f×f footprint anchored at (ax, ay) is free (not a door, not already occupied). */
  const footprintFree = (ax: number, ay: number): boolean => {
    for (let dy = 0; dy < f; dy++) {
      for (let dx = 0; dx < f; dx++) {
        const k = key(ax + dx, ay + dy);
        if (doorSet.has(k) || occupied.has(k)) return false;
      }
    }
    return true;
  };
  /** Does any cell of the footprint's back ROW/COLUMN (the wall it backs onto, `back`) carry a window? */
  const backsOntoWindow = (ax: number, ay: number, back: Edge): boolean => {
    for (let t = 0; t < f; t++) {
      const wx = back === 'w' ? ax : back === 'e' ? ax + f - 1 : ax + t;
      const wy = back === 'n' ? ay : back === 's' ? ay + f - 1 : ay + t;
      if (windowSet.has(`${wx},${wy}|${back}`)) return true;
    }
    return false;
  };

  const program = PROGRAMS[type];
  program.forEach((spec, specIdx) => {
    // Build the deterministic candidate list for this piece (anchor = the footprint's min corner).
    const candidates: Candidate[] = [];
    for (const c of cells) {
      if (!footprintInBounds(c.cx, c.cy)) continue; // the whole f×f piece must fit
      if (!footprintFree(c.cx, c.cy)) continue; // never on a door, never overlap
      if (spec.placement === 'wall') {
        // Wall pieces back onto a room boundary the footprint touches; facing is into the room. Order n,s,e,w so
        // the f=1 candidate stream matches the original (a boundary cell + its OPPOSITE-facing wall placement).
        const backs: Edge[] = [];
        if (c.cy === bounds.minCy) backs.push('n');
        if (c.cy + f - 1 === bounds.maxCy) backs.push('s');
        if (c.cx + f - 1 === bounds.maxCx) backs.push('e');
        if (c.cx === bounds.minCx) backs.push('w');
        for (const back of backs) {
          if (spec.tall && backsOntoWindow(c.cx, c.cy, back)) continue; // tall piece would block a window
          candidates.push({ cx: c.cx, cy: c.cy, facing: OPPOSITE[back] });
        }
      } else {
        // Free-standing: face the room centre from the footprint's centre.
        candidates.push({ cx: c.cx, cy: c.cy, facing: faceCentre(c.cx + (f - 1) / 2, c.cy + (f - 1) / 2) });
      }
    }
    if (candidates.length === 0) return; // no legal spot — scale down gracefully (room too small / full)

    // Deterministic pick: index off the hash stream, then linear-probe until one keeps the path clear.
    const salt = 1009 + specIdx * 31;
    const start = Math.floor(hash01(effSeed, salt) * candidates.length) % candidates.length;
    for (let j = 0; j < candidates.length; j++) {
      const cand = candidates[(start + j) % candidates.length]!;
      if (!footprintFree(cand.cx, cand.cy)) continue; // a different facing of an already-taken footprint
      if (!stillConnected(occupied, cand, f, bounds, doorCells)) continue; // don't seal the room / a doorway
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) occupied.add(key(cand.cx + dx, cand.cy + dy));
      pieces.push({
        kind: spec.kind,
        cell: { cx: cand.cx, cy: cand.cy },
        footprint: { w: f, d: f },
        facing: cand.facing,
        container: spec.container,
      });
      break;
    }
  });

  // Construction guarantees these; assert (a violation is a generator bug, surfaced not hidden).
  if (!furnitureFits(pieces, bounds, doorCells)) {
    throw new Error(`furnishRoom: produced an invalid layout for a ${type} room (overlap / OOB / on a door)`);
  }
  if (!furnitureLeavesPathClear(pieces, bounds, doorCells)) {
    throw new Error(`furnishRoom: sealed the walkable path in a ${type} room`);
  }
  return pieces;
}
