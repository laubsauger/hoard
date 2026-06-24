// P0a — the pure house GENERATOR (procedural-houses, docs/PROCEDURAL-HOUSES.md). Consumes a single-storey
// `HouseTemplate` (the grounded floor-plan library in houseTemplates.ts) and emits a `PlacedHouse`: the
// room-per-cell map, the CELL-EDGE wall segments (interior partitions + exterior walls), the door openings,
// and the exterior window openings — all in WORLD cell coordinates (origin + template cell).
//
// This is the layout SOURCE the scene wiring (P0b) and the renderer (P0c) consume, replacing the old
// perimeter-cell wall gen. It is PURE + deterministic (V26): same template + origin ⇒ identical PlacedHouse,
// no RNG, no GPU/sim deps. Walls live on cell EDGES (the face between two cells, or a cell + outside) exactly
// as docs/PROCEDURAL-HOUSES.md prescribes; doors/windows are openings carried by specific edges.
//
// SINGLE-STOREY ONLY for now (P0): the generator reads level 0. Multi-floor is P3/future.

import {
  cellInRoom,
  roomCells,
  type Door,
  type Edge,
  type FloorPlan,
  type HouseTemplate,
  type RoomType,
  type WindowSpec,
} from './houseTemplates';

/**
 * Cell-subdivision factor the SCENE stamps houses at. The templates are authored on the coarse 2 m grid; the
 * live nav grid runs at navCellSize = 1 m, so the scene places `subdivideTemplate(template, SUBDIV)` to keep
 * each house the SAME physical size (templateW*SUBDIV × templateD*SUBDIV finer cells = identical metres) while
 * gaining a 1 m collision / indoor-nav resolution. Furniture footprints scale by the same factor (a bed stays
 * ≈2 m). placeHouse itself is subdivision-agnostic — it places whatever template it is handed.
 */
export const SUBDIV = 2;

const EDGE_DELTA: Record<Edge, { dx: number; dy: number }> = {
  n: { dx: 0, dy: -1 },
  s: { dx: 0, dy: 1 },
  e: { dx: 1, dy: 0 },
  w: { dx: -1, dy: 0 },
};

/** A footprint cell, placed in WORLD cell coordinates, tagged with the room it belongs to. */
export interface PlacedRoomCell {
  readonly cx: number;
  readonly cy: number;
  /** Room index in the template's level-0 room list (the region id, P0b rooms-as-regions). */
  readonly roomId: number;
  readonly type: RoomType;
}

/** A wall is exterior (on the footprint boundary, one side is outside) or interior (between two rooms). */
export type WallKind = 'exterior' | 'interior';

/**
 * One CELL-EDGE wall segment — the face between two adjacent world cells, or between a boundary cell and the
 * outside. `along` is the axis the wall PANEL runs along: 'x' when the two cells differ in cy (a N/S face),
 * 'z' when they differ in cx (an E/W face) — matching the renderer's face convention. The edge is keyed
 * canonically (`key`) so doors + windows reference the exact same edge instance.
 */
export interface WallEdge {
  readonly key: string;
  readonly along: 'x' | 'z';
  /** A room cell adjacent to this edge (always inside the footprint). */
  readonly innerCx: number;
  readonly innerCy: number;
  /** The cell on the OTHER side: another room cell (interior), or null when outside the footprint (exterior). */
  readonly outerCx: number | null;
  readonly outerCy: number | null;
  readonly kind: WallKind;
  /** For an EXTERIOR edge: the cardinal direction (n/s/e/w) that leaves the footprint — the authoritative outward
   *  face, captured at scan time so the renderer NEVER re-derives it (re-derivation mis-placed some walls). null
   *  for interior partitions (use innerCx/Cy ↔ outerCx/Cy). */
  readonly outwardDir: Edge | null;
  /** Room id on the inner side. */
  readonly innerRoom: number;
  /** Room id on the outer side, or null when exterior. */
  readonly outerRoom: number | null;
}

/** A door OPENING: the wall edge that is left open (the doorway gap), plus which rooms it links. */
export interface PlacedDoor {
  readonly edge: WallEdge;
  /** True for the exterior front/garage door (opens to the outside). */
  readonly exterior: boolean;
  /** True for the single front door the player enters through (the first living/hall exterior door). */
  readonly front: boolean;
  readonly fromRoom: number;
  readonly toRoom: number | null;
  /** World cell the door opening sits in (the `fromRoom` side). */
  readonly cx: number;
  readonly cy: number;
  /** Outward edge direction (n/s/e/w) the door opens through — the side the wall/shell ring sits on. */
  readonly dir: Edge;
}

/** A window OPENING on an exterior wall edge, with the owning room + a deterministic state seed slot. */
export interface PlacedWindow {
  readonly edge: WallEdge;
  readonly room: number;
  readonly type: RoomType;
  /** Deterministic per-house window index (the seed key the sim/render decay derive their state from). */
  readonly slot: number;
  /** World cell the window sits in. */
  readonly cx: number;
  readonly cy: number;
  /** Wall runs along X (a N/S facade) → the renderer rotates the pane. Mirrors WindowPlacement.ns. */
  readonly ns: boolean;
  /** Outward edge direction (n/s/e/w) the window faces — the side the exterior wall/shell ring sits on. */
  readonly dir: Edge;
}

/** A fully placed single-storey house: room map + wall edges + door/window openings, in world cells. */
export interface PlacedHouse {
  readonly template: HouseTemplate;
  readonly originCx: number;
  readonly originCy: number;
  readonly width: number;
  readonly depth: number;
  /** One entry per footprint cell (world coords), tagged with its room. */
  readonly rooms: readonly PlacedRoomCell[];
  /** Every wall edge (interior partitions + exterior walls). Door/window edges are included here too. */
  readonly wallEdges: readonly WallEdge[];
  readonly doors: readonly PlacedDoor[];
  readonly windows: readonly PlacedWindow[];
  /** Room lookup for a world cell, or null when the cell is outside the footprint. */
  roomAt(cx: number, cy: number): { readonly roomId: number; readonly type: RoomType } | null;
}

/**
 * Canonical key for the edge between two adjacent cells, independent of which side is named first. A vertical
 * seam (cells differ in cx, wall runs along Z) is keyed by the LEFT cx; a horizontal seam (differ in cy, wall
 * runs along X) by the TOP cy. So both `(cx → e)` and `(cx+1 → w)` map to the same edge instance.
 */
function edgeKey(cx: number, cy: number, dir: Edge): string {
  const d = EDGE_DELTA[dir];
  if (d.dx !== 0) {
    const leftCx = Math.min(cx, cx + d.dx);
    return `z|${leftCx}|${cy}`;
  }
  const topCy = Math.min(cy, cy + d.dy);
  return `x|${cx}|${topCy}`;
}

/**
 * Place a single-storey `HouseTemplate` at world cell origin `(originCx, originCy)` → a `PlacedHouse`. Pure +
 * deterministic (V26). Reads level 0 only (single-storey P0). Throws if the template has no level 0.
 */
export function placeHouse(template: HouseTemplate, originCx: number, originCy: number): PlacedHouse {
  const plan: FloorPlan | undefined = template.levels.find((l) => l.storey === 0);
  if (!plan) throw new Error(`placeHouse: template ${template.id} has no storey-0 floor plan`);
  const { w, d } = template.footprint;

  // --- room map: each footprint cell → its room (template index). Templates TILE the footprint exactly, so
  // every cell resolves to exactly one room; a stray uncovered cell is a template bug (surfaced, not hidden).
  const roomOf = new Int32Array(w * d).fill(-1);
  const typeOf: RoomType[] = [];
  plan.rooms.forEach((room, roomId) => {
    typeOf[roomId] = room.type;
    for (const c of roomCells(room)) roomOf[c.cy * w + c.cx] = roomId;
  });

  const rooms: PlacedRoomCell[] = [];
  for (let cy = 0; cy < d; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const roomId = roomOf[cy * w + cx]!;
      if (roomId < 0) throw new Error(`placeHouse: template ${template.id} leaves cell (${cx},${cy}) roomless`);
      rooms.push({ cx: originCx + cx, cy: originCy + cy, roomId, type: typeOf[roomId]! });
    }
  }

  // --- wall edges: scan every footprint cell; emit an edge where the neighbour is OUTSIDE (exterior) or in a
  // DIFFERENT room (interior partition). To emit each shared edge ONCE, interior edges are emitted only toward
  // +x ('e') and +y ('s'); exterior (boundary) edges are emitted in whichever direction leaves the footprint.
  const edgeByKey = new Map<string, WallEdge>();
  const roomAtLocal = (cx: number, cy: number): number =>
    cx < 0 || cy < 0 || cx >= w || cy >= d ? -1 : roomOf[cy * w + cx]!;

  const DIRS: Edge[] = ['n', 's', 'e', 'w'];
  for (let cy = 0; cy < d; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const innerRoom = roomOf[cy * w + cx]!;
      for (const dir of DIRS) {
        const dl = EDGE_DELTA[dir];
        const ncx = cx + dl.dx;
        const ncy = cy + dl.dy;
        const outerRoom = roomAtLocal(ncx, ncy);
        const outside = outerRoom < 0;
        const interior = !outside && outerRoom !== innerRoom;
        if (!outside && !interior) continue; // same room — no wall
        // emit each INTERIOR partition once (from the upper/left cell); EXTERIOR edges have only one inner cell.
        if (interior && (dir === 'n' || dir === 'w')) continue;
        const key = edgeKey(cx, cy, dir);
        if (edgeByKey.has(key)) continue;
        const along: 'x' | 'z' = dl.dx !== 0 ? 'z' : 'x';
        edgeByKey.set(key, {
          key,
          along,
          innerCx: originCx + cx,
          innerCy: originCy + cy,
          outerCx: outside ? null : originCx + ncx,
          outerCy: outside ? null : originCy + ncy,
          kind: outside ? 'exterior' : 'interior',
          outwardDir: outside ? dir : null,
          innerRoom,
          outerRoom: outside ? null : outerRoom,
        });
      }
    }
  }

  // --- doors: each template door OPENS the wall edge it sits on. Resolve the edge by its canonical key so a
  // door references the SAME WallEdge instance present in `wallEdges`. The front door is the first exterior
  // door whose room is a believable entry (living/hall) — preserved sheltered-spawn (P0b) keys off it.
  const doors: PlacedDoor[] = [];
  let frontChosen = false;
  for (const door of plan.doors as readonly Door[]) {
    const key = edgeKey(door.atCell.cx, door.atCell.cy, door.edge);
    const edge = edgeByKey.get(key);
    if (!edge) {
      throw new Error(
        `placeHouse: template ${template.id} door from room ${door.fromRoom} (${door.atCell.cx},${door.atCell.cy} ${door.edge}) is not on a wall edge`,
      );
    }
    const exterior = door.toRoom === null;
    const entryType = typeOf[door.fromRoom];
    const front = !frontChosen && exterior && (entryType === 'living' || entryType === 'hall');
    if (front) frontChosen = true;
    doors.push({
      edge,
      exterior,
      front,
      fromRoom: door.fromRoom,
      toRoom: door.toRoom,
      cx: originCx + door.atCell.cx,
      cy: originCy + door.atCell.cy,
      dir: door.edge,
    });
  }

  // --- windows: each template window sits on an EXTERIOR edge of its room; slot is the stable template index.
  const windows: PlacedWindow[] = [];
  (plan.windows as readonly WindowSpec[]).forEach((win, slot) => {
    const key = edgeKey(win.atCell.cx, win.atCell.cy, win.edge);
    const edge = edgeByKey.get(key);
    if (!edge || edge.kind !== 'exterior') {
      throw new Error(
        `placeHouse: template ${template.id} window for room ${win.room} (${win.atCell.cx},${win.atCell.cy} ${win.edge}) is not on an exterior edge`,
      );
    }
    const dl = EDGE_DELTA[win.edge];
    windows.push({
      edge,
      room: win.room,
      type: typeOf[win.room]!,
      slot,
      cx: originCx + win.atCell.cx,
      cy: originCy + win.atCell.cy,
      ns: dl.dy !== 0, // n/s facade → wall runs along X → renderer rotates the pane
      dir: win.edge,
    });
  });

  const wallEdges = [...edgeByKey.values()];

  return {
    template,
    originCx,
    originCy,
    width: w,
    depth: d,
    rooms,
    wallEdges,
    doors,
    windows,
    roomAt(cx: number, cy: number) {
      const lx = cx - originCx;
      const ly = cy - originCy;
      if (lx < 0 || ly < 0 || lx >= w || ly >= d) return null;
      const roomId = roomOf[ly * w + lx]!;
      return { roomId, type: typeOf[roomId]! };
    },
  };
}

/** The single-storey templates the P0 placer accepts (multi-floor is P3 — colonial-2storey is excluded). */
export function isSingleStorey(template: HouseTemplate): boolean {
  return template.storeys === 1;
}

// re-export the helper the tests/consumers lean on for the door/window cross-check.
export { cellInRoom };
