// Grounded floor-plan TEMPLATE LIBRARY (procedural-houses research step — see docs/PROCEDURAL-HOUSES.md).
//
// This is DATA + SCHEMA + pure validation helpers ONLY. No generator, no rendering, no sim wiring. The
// future P0 generator (docs/PROCEDURAL-HOUSES.md) will consume these templates to emit walls/doors/windows
// from the room partitions, replacing the perimeter-only wall gen. Here we just encode believable suburban
// floor plans, grounded in real ranch/bungalow/colonial layouts, as a stack of typed rooms that TILE a cell
// footprint with no gaps and no overlaps.
//
// GRID. The game nav grid uses navCellSize = 2 m/cell (~6.5 ft). Templates are authored in CELLS: a house
// footprint is ~5-9 cells wide x 4-7 cells deep (~10-18 m x 8-14 m) and a room is 1-4 cells. 2 m cells are
// coarse on purpose — a finer wall resolution (sub-cell partitions / half-cell doorways) may be layered on
// later; the template grammar stays the same, only the cell pitch tightens.
//
// COORDINATES. Cells use (cx, cy): cx in [0, w-1] (x / width), cy in [0, d-1] (y / depth). cy increases
// SOUTHWARD ("down" the plan). Room bounds are INCLUSIVE cell rectangles relative to the footprint origin
// (0, 0). Edges: 'n' = -cy, 's' = +cy, 'e' = +cx, 'w' = -cx.

/** Project-Zomboid-style room definition: the TYPE drives furniture + loot for the future P1 pass. */
export type RoomType =
  | 'kitchen'
  | 'bedroom'
  | 'bathroom'
  | 'living'
  | 'dining'
  | 'hall'
  | 'garage'
  | 'closet'
  | 'laundry';

/** Which side of a cell an opening sits on. 'n' = -cy, 's' = +cy, 'e' = +cx, 'w' = -cx. */
export type Edge = 'n' | 's' | 'e' | 'w';

/** A single grid cell (inclusive integer coordinates within the footprint). */
export interface Cell {
  readonly cx: number;
  readonly cy: number;
}

/** Inclusive cell rectangle: minCx..maxCx x minCy..maxCy. */
export interface CellRect {
  readonly minCx: number;
  readonly minCy: number;
  readonly maxCx: number;
  readonly maxCy: number;
}

/** A typed room occupying an axis-aligned, inclusive cell rectangle. */
export interface Room {
  readonly type: RoomType;
  readonly bounds: CellRect;
}

/**
 * An opening between two rooms, or to the exterior.
 * - `toRoom === null` ⇒ an EXTERIOR door (the front door / garage door): `atCell` sits in `fromRoom` on the
 *   footprint boundary, opening to the outside through `edge`.
 * - `toRoom !== null` ⇒ an INTERIOR door: `atCell` sits in `fromRoom` and the cell one step in `edge`
 *   direction sits in `toRoom` (i.e. the opening straddles the shared partition wall).
 */
export interface Door {
  readonly fromRoom: number;
  readonly toRoom: number | null;
  readonly edge: Edge;
  readonly atCell: Cell;
}

/** A window — ONLY ever on an EXTERIOR wall (a room edge that is also the footprint boundary). */
export interface WindowSpec {
  readonly room: number;
  readonly edge: Edge;
  readonly atCell: Cell;
}

/** One storey's layout. Rooms TILE the footprint exactly; doors/windows reference rooms by index. */
export interface FloorPlan {
  readonly storey: 0 | 1;
  readonly rooms: readonly Room[];
  readonly doors: readonly Door[];
  readonly windows: readonly WindowSpec[];
  /** Cell where the stairs UP to the next storey sit; null for a single storey or the top floor. */
  readonly stairsCell: Cell | null;
}

/** A footprint size in cells. cx in [0, w-1], cy in [0, d-1]. */
export interface Footprint {
  readonly w: number;
  readonly d: number;
}

/** A hand-authored house archetype: a footprint + one FloorPlan per storey. */
export interface HouseTemplate {
  readonly id: string;
  readonly name: string;
  readonly storeys: 1 | 2;
  readonly footprint: Footprint;
  readonly levels: readonly FloorPlan[];
}

// ---------------------------------------------------------------------------------------------------------
// Pure validation helpers (no GPU / sim deps). The future generator + the test suite both reuse these.
// ---------------------------------------------------------------------------------------------------------

const EDGE_DELTA: Record<Edge, { dx: number; dy: number }> = {
  n: { dx: 0, dy: -1 },
  s: { dx: 0, dy: 1 },
  e: { dx: 1, dy: 0 },
  w: { dx: -1, dy: 0 },
};

/** Is `cell` inside the footprint (cx in [0,w-1], cy in [0,d-1])? */
export function inFootprint(cell: Cell, footprint: Footprint): boolean {
  return cell.cx >= 0 && cell.cx < footprint.w && cell.cy >= 0 && cell.cy < footprint.d;
}

/** Is `cell` within a room's inclusive bounds? */
export function cellInRoom(cell: Cell, room: Room): boolean {
  const b = room.bounds;
  return cell.cx >= b.minCx && cell.cx <= b.maxCx && cell.cy >= b.minCy && cell.cy <= b.maxCy;
}

/** Every cell a room covers. */
export function roomCells(room: Room): Cell[] {
  const b = room.bounds;
  const cells: Cell[] = [];
  for (let cy = b.minCy; cy <= b.maxCy; cy++) {
    for (let cx = b.minCx; cx <= b.maxCx; cx++) cells.push({ cx, cy });
  }
  return cells;
}

/**
 * TILE CHECK: the rooms tile the footprint EXACTLY — every footprint cell is covered by exactly one room,
 * every room is in-bounds, and every room has min <= max. Returns true iff the partition is well-formed.
 */
export function tileCheck(rooms: readonly Room[], footprint: Footprint): boolean {
  const { w, d } = footprint;
  const cover = new Array<number>(w * d).fill(0);
  for (const room of rooms) {
    const b = room.bounds;
    if (b.minCx > b.maxCx || b.minCy > b.maxCy) return false; // degenerate
    if (b.minCx < 0 || b.minCy < 0 || b.maxCx >= w || b.maxCy >= d) return false; // out of bounds
    for (let cy = b.minCy; cy <= b.maxCy; cy++) {
      for (let cx = b.minCx; cx <= b.maxCx; cx++) {
        cover[cy * w + cx] = (cover[cy * w + cx] ?? 0) + 1; // overlap ⇒ a cell ends > 1
      }
    }
  }
  return cover.every((n) => n === 1); // exactly-once cover ⇒ no gaps, no overlaps
}

/**
 * Is this door placed on a real opening?
 * - exterior (`toRoom === null`): `atCell` is in `fromRoom` and the neighbour in `edge` is OUTSIDE the
 *   footprint (so the opening punches the exterior wall).
 * - interior: `atCell` is in `fromRoom` and the neighbour in `edge` is in `toRoom` (the two cells straddle
 *   the shared partition, i.e. the door sits on the wall between the rooms).
 */
export function doorPlacementValid(door: Door, rooms: readonly Room[], footprint: Footprint): boolean {
  const from = rooms[door.fromRoom];
  if (!from) return false;
  if (!cellInRoom(door.atCell, from)) return false;
  const d = EDGE_DELTA[door.edge];
  const nb: Cell = { cx: door.atCell.cx + d.dx, cy: door.atCell.cy + d.dy };
  if (door.toRoom === null) return !inFootprint(nb, footprint); // exterior: opens outside
  const to = rooms[door.toRoom];
  if (!to) return false;
  return cellInRoom(nb, to); // interior: neighbour cell belongs to the target room
}

/**
 * Is this window on an EXTERIOR wall of its room? `atCell` must be in the room and the neighbour cell in
 * `edge` direction must be OUTSIDE the footprint — i.e. the room edge there is the footprint boundary. This
 * rejects windows on interior partitions (where the neighbour would be inside the footprint).
 */
export function windowOnExterior(win: WindowSpec, rooms: readonly Room[], footprint: Footprint): boolean {
  const room = rooms[win.room];
  if (!room) return false;
  if (!cellInRoom(win.atCell, room)) return false;
  const d = EDGE_DELTA[win.edge];
  const nb: Cell = { cx: win.atCell.cx + d.dx, cy: win.atCell.cy + d.dy };
  return !inFootprint(nb, footprint);
}

/**
 * DOOR GRAPH CONNECTED: treating rooms as nodes and INTERIOR doors (toRoom !== null) as undirected edges,
 * is the graph a single connected component spanning every room? (Reachability between every pair of rooms.)
 */
export function doorGraphConnected(rooms: readonly Room[], doors: readonly Door[]): boolean {
  const n = rooms.length;
  if (n === 0) return false;
  if (n === 1) return true;
  const adj: number[][] = rooms.map(() => []);
  for (const door of doors) {
    if (door.toRoom === null) continue; // exterior doors are not graph edges
    const a = door.fromRoom;
    const b = door.toRoom;
    if (a < 0 || a >= n || b < 0 || b >= n) return false;
    adj[a]!.push(b);
    adj[b]!.push(a);
  }
  const seen = new Array<boolean>(n).fill(false);
  const stack = [0];
  seen[0] = true;
  let count = 1;
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const next of adj[cur]!) {
      if (!seen[next]) {
        seen[next] = true;
        count += 1;
        stack.push(next);
      }
    }
  }
  return count === n;
}

/**
 * REACHABLE FROM EXTERIOR: every room is reachable, via interior doors, starting from the room(s) that own an
 * EXTERIOR (front/garage) door. Returns false if the level has no exterior door (e.g. an upstairs floor — its
 * connectivity is checked with doorGraphConnected and it is entered via the stairs cell, not a front door).
 */
export function reachableFromExterior(rooms: readonly Room[], doors: readonly Door[]): boolean {
  const n = rooms.length;
  if (n === 0) return false;
  const entries = doors.filter((d) => d.toRoom === null).map((d) => d.fromRoom);
  if (entries.length === 0) return false;
  const adj: number[][] = rooms.map(() => []);
  for (const door of doors) {
    if (door.toRoom === null) continue;
    const a = door.fromRoom;
    const b = door.toRoom;
    if (a < 0 || a >= n || b < 0 || b >= n) return false;
    adj[a]!.push(b);
    adj[b]!.push(a);
  }
  const seen = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  for (const e of entries) {
    if (e >= 0 && e < n && !seen[e]) {
      seen[e] = true;
      stack.push(e);
    }
  }
  let count = stack.length;
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const next of adj[cur]!) {
      if (!seen[next]) {
        seen[next] = true;
        count += 1;
        stack.push(next);
      }
    }
  }
  return count === n;
}

// ---------------------------------------------------------------------------------------------------------
// The hand-authored templates. Each is grounded in a real suburban layout (room sizes ~ the foot dimensions
// in docs/PROCEDURAL-HOUSES.md, mapped onto the 2 m cell grid). The room ORDER is the index space that doors
// and windows reference.
// ---------------------------------------------------------------------------------------------------------

const r = (type: RoomType, minCx: number, minCy: number, maxCx: number, maxCy: number): Room => ({
  type,
  bounds: { minCx, minCy, maxCx, maxCy },
});

/**
 * 1) RANCH-2BED — small single-storey ranch, 7x5 cells (~14 m x 10 m). Bedroom wing (2 beds + bath) at the
 * west end, a central hall spine, and an open living/kitchen/dining group at the east end buffering the beds.
 *
 *   cx:  0   1   2   3   4   5   6
 *   cy0  bedA bedA bedA H  liv liv liv
 *   cy1  bedA bedA bedA H  liv liv liv
 *   cy2  bath bath bath H  liv liv liv
 *   cy3  bedB bedB bedB H  kit kit din
 *   cy4  bedB bedB bedB H  kit kit din
 */
const RANCH_2BED: HouseTemplate = {
  id: 'ranch-2bed',
  name: 'Ranch — 2 bed / 1 bath',
  storeys: 1,
  footprint: { w: 7, d: 5 },
  levels: [
    {
      storey: 0,
      rooms: [
        r('bedroom', 0, 0, 2, 1), // 0 bedroom A
        r('bathroom', 0, 2, 2, 2), // 1 bathroom
        r('bedroom', 0, 3, 2, 4), // 2 bedroom B
        r('hall', 3, 0, 3, 4), // 3 hall spine
        r('living', 4, 0, 6, 2), // 4 living
        r('kitchen', 4, 3, 5, 4), // 5 kitchen
        r('dining', 6, 3, 6, 4), // 6 dining
      ],
      doors: [
        { fromRoom: 4, toRoom: null, edge: 'n', atCell: { cx: 5, cy: 0 } }, // front door (living)
        { fromRoom: 4, toRoom: 3, edge: 'w', atCell: { cx: 4, cy: 1 } }, // living -> hall
        { fromRoom: 3, toRoom: 0, edge: 'w', atCell: { cx: 3, cy: 0 } }, // hall -> bedroom A
        { fromRoom: 3, toRoom: 1, edge: 'w', atCell: { cx: 3, cy: 2 } }, // hall -> bathroom
        { fromRoom: 3, toRoom: 2, edge: 'w', atCell: { cx: 3, cy: 4 } }, // hall -> bedroom B
        { fromRoom: 4, toRoom: 5, edge: 's', atCell: { cx: 4, cy: 2 } }, // living -> kitchen
        { fromRoom: 5, toRoom: 6, edge: 'e', atCell: { cx: 5, cy: 3 } }, // kitchen -> dining
      ],
      windows: [
        { room: 0, edge: 'w', atCell: { cx: 0, cy: 0 } },
        { room: 0, edge: 'n', atCell: { cx: 1, cy: 0 } },
        { room: 2, edge: 'w', atCell: { cx: 0, cy: 4 } },
        { room: 4, edge: 'n', atCell: { cx: 4, cy: 0 } },
        { room: 4, edge: 'e', atCell: { cx: 6, cy: 1 } },
        { room: 5, edge: 's', atCell: { cx: 4, cy: 4 } },
        { room: 6, edge: 'e', atCell: { cx: 6, cy: 4 } },
      ],
      stairsCell: null,
    },
  ],
};

/**
 * 2) RANCH-3BED — larger single-storey ranch, 9x6 cells (~18 m x 12 m). Master suite (bed + ensuite + walk-in
 * closet) at the west end off the living room; central living/dining/kitchen; a hall spine on the east serving
 * a half-bath and two family bedrooms.
 *
 *   cx:  0     1     2     3    4    5    6    7    8
 *   cy0  mbed  mbed  mbed  liv  liv  liv  H    bed2 bed2
 *   cy1  mbed  mbed  mbed  liv  liv  liv  H    bed2 bed2
 *   cy2  mbed  mbed  mbed  liv  liv  liv  H    bed2 bed2
 *   cy3  mbed  mbed  mbed  kit  kit  din  H    bed3 bed3
 *   cy4  mbth  mbth  clo   kit  kit  din  H    bed3 bed3
 *   cy5  mbth  mbth  clo   kit  kit  bth2 H    bed3 bed3
 */
const RANCH_3BED: HouseTemplate = {
  id: 'ranch-3bed',
  name: 'Ranch — 3 bed / 1.5 bath',
  storeys: 1,
  footprint: { w: 9, d: 6 },
  levels: [
    {
      storey: 0,
      rooms: [
        r('bedroom', 0, 0, 2, 3), // 0 master bedroom
        r('bathroom', 0, 4, 1, 5), // 1 master ensuite
        r('closet', 2, 4, 2, 5), // 2 master walk-in closet
        r('living', 3, 0, 5, 2), // 3 living
        r('kitchen', 3, 3, 4, 5), // 4 kitchen
        r('dining', 5, 3, 5, 4), // 5 dining
        r('bathroom', 5, 5, 5, 5), // 6 half-bath (off hall)
        r('hall', 6, 0, 6, 5), // 7 hall spine
        r('bedroom', 7, 0, 8, 2), // 8 bedroom 2
        r('bedroom', 7, 3, 8, 5), // 9 bedroom 3
      ],
      doors: [
        { fromRoom: 3, toRoom: null, edge: 'n', atCell: { cx: 4, cy: 0 } }, // front door (living)
        { fromRoom: 3, toRoom: 0, edge: 'w', atCell: { cx: 3, cy: 1 } }, // living -> master bedroom
        { fromRoom: 3, toRoom: 7, edge: 'e', atCell: { cx: 5, cy: 0 } }, // living -> hall
        { fromRoom: 3, toRoom: 4, edge: 's', atCell: { cx: 3, cy: 2 } }, // living -> kitchen
        { fromRoom: 0, toRoom: 1, edge: 's', atCell: { cx: 0, cy: 3 } }, // master -> ensuite
        { fromRoom: 0, toRoom: 2, edge: 's', atCell: { cx: 2, cy: 3 } }, // master -> closet
        { fromRoom: 4, toRoom: 5, edge: 'e', atCell: { cx: 4, cy: 3 } }, // kitchen -> dining
        { fromRoom: 5, toRoom: 7, edge: 'e', atCell: { cx: 5, cy: 3 } }, // dining -> hall
        { fromRoom: 6, toRoom: 7, edge: 'e', atCell: { cx: 5, cy: 5 } }, // half-bath -> hall
        { fromRoom: 7, toRoom: 8, edge: 'e', atCell: { cx: 6, cy: 0 } }, // hall -> bedroom 2
        { fromRoom: 7, toRoom: 9, edge: 'e', atCell: { cx: 6, cy: 4 } }, // hall -> bedroom 3
      ],
      windows: [
        { room: 0, edge: 'n', atCell: { cx: 1, cy: 0 } },
        { room: 0, edge: 'w', atCell: { cx: 0, cy: 1 } },
        { room: 3, edge: 'n', atCell: { cx: 3, cy: 0 } },
        { room: 4, edge: 's', atCell: { cx: 3, cy: 5 } },
        { room: 8, edge: 'n', atCell: { cx: 7, cy: 0 } },
        { room: 8, edge: 'e', atCell: { cx: 8, cy: 1 } },
        { room: 9, edge: 'e', atCell: { cx: 8, cy: 4 } },
        { room: 9, edge: 's', atCell: { cx: 8, cy: 5 } },
      ],
      stairsCell: null,
    },
  ],
};

/**
 * 3) BUNGALOW-2BED — compact, deeper-than-wide bungalow, 5x6 cells (~10 m x 12 m), for street variety. Public
 * front (living + open kitchen/dining), private back (2 beds flanking a short hall + bathroom).
 *
 *   cx:  0    1    2    3    4
 *   cy0  liv  liv  liv  kit  kit
 *   cy1  liv  liv  liv  kit  kit
 *   cy2  liv  liv  liv  kit  kit
 *   cy3  bed1 bed1 H    bed2 bed2
 *   cy4  bed1 bed1 H    bed2 bed2
 *   cy5  bed1 bed1 bth  bed2 bed2
 */
const BUNGALOW_2BED: HouseTemplate = {
  id: 'bungalow-2bed',
  name: 'Bungalow — 2 bed / 1 bath',
  storeys: 1,
  footprint: { w: 5, d: 6 },
  levels: [
    {
      storey: 0,
      rooms: [
        r('living', 0, 0, 2, 2), // 0 living
        r('kitchen', 3, 0, 4, 2), // 1 kitchen (open dining)
        r('bedroom', 0, 3, 1, 5), // 2 bedroom 1
        r('bedroom', 3, 3, 4, 5), // 3 bedroom 2
        r('hall', 2, 3, 2, 4), // 4 hall
        r('bathroom', 2, 5, 2, 5), // 5 bathroom
      ],
      doors: [
        { fromRoom: 0, toRoom: null, edge: 'n', atCell: { cx: 1, cy: 0 } }, // front door (living)
        { fromRoom: 0, toRoom: 1, edge: 'e', atCell: { cx: 2, cy: 0 } }, // living -> kitchen
        { fromRoom: 0, toRoom: 4, edge: 's', atCell: { cx: 2, cy: 2 } }, // living -> hall
        { fromRoom: 4, toRoom: 2, edge: 'w', atCell: { cx: 2, cy: 3 } }, // hall -> bedroom 1
        { fromRoom: 4, toRoom: 3, edge: 'e', atCell: { cx: 2, cy: 3 } }, // hall -> bedroom 2
        { fromRoom: 4, toRoom: 5, edge: 's', atCell: { cx: 2, cy: 4 } }, // hall -> bathroom
      ],
      windows: [
        { room: 0, edge: 'n', atCell: { cx: 0, cy: 0 } },
        { room: 0, edge: 'w', atCell: { cx: 0, cy: 1 } },
        { room: 1, edge: 'n', atCell: { cx: 4, cy: 0 } },
        { room: 1, edge: 'e', atCell: { cx: 4, cy: 1 } },
        { room: 2, edge: 'w', atCell: { cx: 0, cy: 4 } },
        { room: 2, edge: 's', atCell: { cx: 0, cy: 5 } },
        { room: 3, edge: 'e', atCell: { cx: 4, cy: 4 } },
        { room: 3, edge: 's', atCell: { cx: 4, cy: 5 } },
      ],
      stairsCell: null,
    },
  ],
};

/**
 * 4) GARAGE-RANCH — single-storey ranch with an attached 2-car garage, 9x5 cells (~18 m x 10 m). Bedroom wing
 * (2 beds + bath) at the west, central hall, living/kitchen/dining, and a front-facing garage at the NE with
 * its big exterior garage door + an interior door through to the dining/kitchen side.
 *
 *   cx:  0    1    2    3   4    5    6    7    8
 *   cy0  bed1 bed1 bed1 H   liv  liv  gar  gar  gar
 *   cy1  bed1 bed1 bed1 H   liv  liv  gar  gar  gar
 *   cy2  bth  bth  bth  H   liv  liv  gar  gar  gar
 *   cy3  bed2 bed2 bed2 H   kit  kit  din  din  din
 *   cy4  bed2 bed2 bed2 H   kit  kit  din  din  din
 */
const GARAGE_RANCH: HouseTemplate = {
  id: 'garage-ranch',
  name: 'Ranch — 2 bed + 2-car garage',
  storeys: 1,
  footprint: { w: 9, d: 5 },
  levels: [
    {
      storey: 0,
      rooms: [
        r('bedroom', 0, 0, 2, 1), // 0 bedroom 1
        r('bathroom', 0, 2, 2, 2), // 1 bathroom
        r('bedroom', 0, 3, 2, 4), // 2 bedroom 2
        r('hall', 3, 0, 3, 4), // 3 hall spine
        r('living', 4, 0, 5, 2), // 4 living
        r('kitchen', 4, 3, 5, 4), // 5 kitchen
        r('dining', 6, 3, 8, 4), // 6 dining
        r('garage', 6, 0, 8, 2), // 7 garage (2-car)
      ],
      doors: [
        { fromRoom: 4, toRoom: null, edge: 'n', atCell: { cx: 4, cy: 0 } }, // front door (living)
        { fromRoom: 7, toRoom: null, edge: 'n', atCell: { cx: 7, cy: 0 } }, // garage door (exterior)
        { fromRoom: 4, toRoom: 3, edge: 'w', atCell: { cx: 4, cy: 1 } }, // living -> hall
        { fromRoom: 3, toRoom: 0, edge: 'w', atCell: { cx: 3, cy: 0 } }, // hall -> bedroom 1
        { fromRoom: 3, toRoom: 1, edge: 'w', atCell: { cx: 3, cy: 2 } }, // hall -> bathroom
        { fromRoom: 3, toRoom: 2, edge: 'w', atCell: { cx: 3, cy: 4 } }, // hall -> bedroom 2
        { fromRoom: 4, toRoom: 5, edge: 's', atCell: { cx: 4, cy: 2 } }, // living -> kitchen
        { fromRoom: 5, toRoom: 6, edge: 'e', atCell: { cx: 5, cy: 3 } }, // kitchen -> dining
        { fromRoom: 7, toRoom: 6, edge: 's', atCell: { cx: 7, cy: 2 } }, // garage -> dining (interior)
      ],
      windows: [
        { room: 0, edge: 'n', atCell: { cx: 1, cy: 0 } },
        { room: 0, edge: 'w', atCell: { cx: 0, cy: 1 } },
        { room: 2, edge: 'w', atCell: { cx: 0, cy: 4 } },
        { room: 2, edge: 's', atCell: { cx: 1, cy: 4 } },
        { room: 4, edge: 'n', atCell: { cx: 5, cy: 0 } },
        { room: 5, edge: 's', atCell: { cx: 4, cy: 4 } },
        { room: 6, edge: 's', atCell: { cx: 7, cy: 4 } },
        { room: 6, edge: 'e', atCell: { cx: 8, cy: 4 } },
      ],
      stairsCell: null,
    },
  ],
};

/**
 * 5) COLONIAL-2STOREY — a real TWO-storey colonial, 6x5 cells (~12 m x 10 m), same footprint on both floors.
 * Exercises the multi-floor schema (the sim's multi-floor support is P3/future — here it is just data). A
 * central front-to-back hall holds the STAIRS; ground floor is living/dining/kitchen/half-bath, upstairs is
 * three bedrooms + a full bath off the landing.
 *
 * Level 0:                              Level 1:
 *   cx:  0    1   2  3    4    5          cx:  0     1   2  3    4    5
 *   cy0  liv  liv H  din  din  din        cy0  mbed  mbed H  bed2 bed2 bed2
 *   cy1  liv  liv H  din  din  din        cy1  mbed  mbed H  bed2 bed2 bed2
 *   cy2  liv  liv H  din  din  din        cy2  mbed  mbed H  bed2 bed2 bed2
 *   cy3  hbth hbth H  kit  kit  kit       cy3  bth   bth  H  bed3 bed3 bed3
 *   cy4  hbth hbth H  kit  kit  kit       cy4  bth   bth  H  bed3 bed3 bed3
 *
 * Stairs sit at (2,2) in the hall on level 0 and arrive in the landing-hall on level 1 (same cell column).
 */
const COLONIAL_2STOREY: HouseTemplate = {
  id: 'colonial-2storey',
  name: 'Colonial — 2 storey / 3 bed',
  storeys: 2,
  footprint: { w: 6, d: 5 },
  levels: [
    {
      storey: 0,
      rooms: [
        r('living', 0, 0, 1, 2), // 0 living
        r('hall', 2, 0, 2, 4), // 1 central hall (stairs)
        r('dining', 3, 0, 5, 2), // 2 dining
        r('kitchen', 3, 3, 5, 4), // 3 kitchen
        r('bathroom', 0, 3, 1, 4), // 4 half-bath
      ],
      doors: [
        { fromRoom: 1, toRoom: null, edge: 'n', atCell: { cx: 2, cy: 0 } }, // front door (hall)
        { fromRoom: 1, toRoom: 0, edge: 'w', atCell: { cx: 2, cy: 1 } }, // hall -> living
        { fromRoom: 1, toRoom: 2, edge: 'e', atCell: { cx: 2, cy: 1 } }, // hall -> dining
        { fromRoom: 1, toRoom: 4, edge: 'w', atCell: { cx: 2, cy: 3 } }, // hall -> half-bath
        { fromRoom: 1, toRoom: 3, edge: 'e', atCell: { cx: 2, cy: 4 } }, // hall -> kitchen
        { fromRoom: 2, toRoom: 3, edge: 's', atCell: { cx: 3, cy: 2 } }, // dining -> kitchen
      ],
      windows: [
        { room: 0, edge: 'n', atCell: { cx: 0, cy: 0 } },
        { room: 0, edge: 'w', atCell: { cx: 0, cy: 1 } },
        { room: 2, edge: 'n', atCell: { cx: 4, cy: 0 } },
        { room: 2, edge: 'e', atCell: { cx: 5, cy: 1 } },
        { room: 3, edge: 's', atCell: { cx: 4, cy: 4 } },
        { room: 3, edge: 'e', atCell: { cx: 5, cy: 3 } },
      ],
      stairsCell: { cx: 2, cy: 2 }, // up to level 1 (lands in the level-1 hall)
    },
    {
      storey: 1,
      rooms: [
        r('bedroom', 0, 0, 1, 2), // 0 master bedroom
        r('hall', 2, 0, 2, 4), // 1 landing hall (stairs arrive)
        r('bedroom', 3, 0, 5, 2), // 2 bedroom 2
        r('bedroom', 3, 3, 5, 4), // 3 bedroom 3
        r('bathroom', 0, 3, 1, 4), // 4 full bath
      ],
      doors: [
        { fromRoom: 1, toRoom: 0, edge: 'w', atCell: { cx: 2, cy: 1 } }, // landing -> master
        { fromRoom: 1, toRoom: 2, edge: 'e', atCell: { cx: 2, cy: 1 } }, // landing -> bedroom 2
        { fromRoom: 1, toRoom: 4, edge: 'w', atCell: { cx: 2, cy: 3 } }, // landing -> full bath
        { fromRoom: 1, toRoom: 3, edge: 'e', atCell: { cx: 2, cy: 4 } }, // landing -> bedroom 3
      ],
      windows: [
        { room: 0, edge: 'n', atCell: { cx: 0, cy: 0 } },
        { room: 0, edge: 'w', atCell: { cx: 0, cy: 1 } },
        { room: 2, edge: 'n', atCell: { cx: 4, cy: 0 } },
        { room: 2, edge: 'e', atCell: { cx: 5, cy: 1 } },
        { room: 3, edge: 'e', atCell: { cx: 5, cy: 4 } },
        { room: 3, edge: 's', atCell: { cx: 4, cy: 4 } },
      ],
      stairsCell: null, // top floor
    },
  ],
};

/** The grounded floor-plan template library the future P0 generator consumes. */
export const HOUSE_TEMPLATES: readonly HouseTemplate[] = [
  RANCH_2BED,
  RANCH_3BED,
  BUNGALOW_2BED,
  GARAGE_RANCH,
  COLONIAL_2STOREY,
];
