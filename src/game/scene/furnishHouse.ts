// P1b — adapt a PLACED HOUSE (placeHouse.ts) into per-room furniture, in WORLD cells. This is the bridge between
// the pure layout placer (furnishRoom.ts — space-agnostic, one room at a time) and the scene (cityDistrict.ts):
// for every room of a placed house it derives the room's world bounds + door cells + exterior edges + windows
// straight off the PlacedHouse, calls furnishRoom with the HOUSE seed (the placer mixes in the room's type +
// bounds, so one seed yields varied per-room layouts — V26), and tags each emitted piece with its house + room
// type + solidity. The output `PlacedFurniture[]` is what the nav-block pass (furnitureSolidity) and the render
// pass (furnitureBuilder) consume. Pure + deterministic; no three/GPU/nav deps.

import { furnishRoom, type RoomWindow } from './furnishRoom';
import { isFurnitureSolid } from './furnitureSolidity';
import type { Cell, CellRect, Edge, RoomType } from './houseTemplates';
import type { PlacedHouse } from './placeHouse';
import type { PlacedFurniture } from './testBlock';

/** Per-room data derived from the placed house, in WORLD cells, ready to feed furnishRoom. */
interface RoomLayout {
  readonly roomId: number;
  readonly type: RoomType;
  readonly bounds: CellRect;
  readonly doorCells: Cell[];
  readonly windows: RoomWindow[];
  readonly exteriorEdges: Edge[];
}

/** The outward edge direction stepped from a fromRoom door cell, in WORLD cells (the toRoom-side opening cell). */
const STEP: Record<Edge, { dx: number; dy: number }> = {
  n: { dx: 0, dy: -1 },
  s: { dx: 0, dy: 1 },
  e: { dx: 1, dy: 0 },
  w: { dx: -1, dy: 0 },
};

/** Group a placed house's cells into per-room world bounds + openings + exterior edges. */
function roomLayouts(placed: PlacedHouse): RoomLayout[] {
  // world interior bounds of the whole footprint (the room cells, inside the wall ring).
  const intMinCx = placed.originCx;
  const intMinCy = placed.originCy;
  const intMaxCx = placed.originCx + placed.width - 1;
  const intMaxCy = placed.originCy + placed.depth - 1;

  // per-room bounding rect over its world cells.
  const bounds = new Map<number, { minCx: number; minCy: number; maxCx: number; maxCy: number; type: RoomType }>();
  for (const rc of placed.rooms) {
    const b = bounds.get(rc.roomId);
    if (!b) {
      bounds.set(rc.roomId, { minCx: rc.cx, minCy: rc.cy, maxCx: rc.cx, maxCy: rc.cy, type: rc.type });
    } else {
      b.minCx = Math.min(b.minCx, rc.cx);
      b.minCy = Math.min(b.minCy, rc.cy);
      b.maxCx = Math.max(b.maxCx, rc.cx);
      b.maxCy = Math.max(b.maxCy, rc.cy);
    }
  }

  // door opening cells per room: the fromRoom side cell (cx,cy) for its room, and the toRoom-side cell (one step
  // in `dir`) for the room on the other side of an interior door.
  const doorsByRoom = new Map<number, Cell[]>();
  const pushDoor = (room: number, cell: Cell): void => {
    const list = doorsByRoom.get(room) ?? [];
    list.push(cell);
    doorsByRoom.set(room, list);
  };
  for (const door of placed.doors) {
    pushDoor(door.fromRoom, { cx: door.cx, cy: door.cy });
    if (door.toRoom !== null) {
      const s = STEP[door.dir];
      pushDoor(door.toRoom, { cx: door.cx + s.dx, cy: door.cy + s.dy });
    }
  }

  // windows per room (each is already a room cell on an exterior wall, carrying its outward edge).
  const winByRoom = new Map<number, RoomWindow[]>();
  for (const win of placed.windows) {
    const list = winByRoom.get(win.room) ?? [];
    list.push({ edge: win.dir, cell: { cx: win.cx, cy: win.cy } });
    winByRoom.set(win.room, list);
  }

  const out: RoomLayout[] = [];
  for (const [roomId, b] of bounds) {
    const exteriorEdges: Edge[] = [];
    if (b.minCy === intMinCy) exteriorEdges.push('n');
    if (b.maxCy === intMaxCy) exteriorEdges.push('s');
    if (b.minCx === intMinCx) exteriorEdges.push('w');
    if (b.maxCx === intMaxCx) exteriorEdges.push('e');
    out.push({
      roomId,
      type: b.type,
      bounds: { minCx: b.minCx, minCy: b.minCy, maxCx: b.maxCx, maxCy: b.maxCy },
      doorCells: doorsByRoom.get(roomId) ?? [],
      windows: winByRoom.get(roomId) ?? [],
      exteriorEdges,
    });
  }
  // stable order by roomId so the furniture list is deterministic regardless of Map iteration nuances.
  out.sort((a, b) => a.roomId - b.roomId);
  return out;
}

/**
 * Furnish every room of a placed house → world-cell `PlacedFurniture[]`. Deterministic (V26): same (placed, seed)
 * ⇒ identical list. Each piece carries its house index, room type, solidity flag (for the nav-block pass) and its
 * loot container source (for the loot pass). Windows on exterior edges are honoured by furnishRoom (a tall piece
 * won't back onto a window); door cells are kept clear; the placer guarantees a walkable path in every room.
 */
export function furnishHouse(placed: PlacedHouse, houseIndex: number, seed: number): PlacedFurniture[] {
  const out: PlacedFurniture[] = [];
  for (const room of roomLayouts(placed)) {
    const pieces = furnishRoom({
      type: room.type,
      bounds: room.bounds,
      seed,
      doorCells: room.doorCells,
      windows: room.windows,
      exteriorEdges: room.exteriorEdges,
    });
    for (const p of pieces) {
      out.push({
        kind: p.kind,
        cx: p.cell.cx,
        cy: p.cell.cy,
        footprint: { w: p.footprint.w, d: p.footprint.d },
        facing: p.facing,
        solid: isFurnitureSolid(p.kind),
        container: p.container,
        houseIndex,
        roomId: room.roomId,
        roomType: room.type,
      });
    }
  }
  return out;
}
