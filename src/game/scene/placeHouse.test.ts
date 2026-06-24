// P0a — the pure house generator (placeHouse). Proves that for every single-storey template the PlacedHouse
// is well-formed: rooms tile the placed footprint, interior wall edges sit EXACTLY between differing rooms,
// exterior edges sit on the footprint boundary, and every door/window lands on a real wall edge that the
// template validators (houseTemplates) independently accept. Pure data — no GPU/sim deps.
import { describe, it, expect } from 'vitest';
import {
  HOUSE_TEMPLATES,
  doorPlacementValid,
  windowOnExterior,
  cellInRoom,
  type HouseTemplate,
} from './houseTemplates';
import { placeHouse, type PlacedHouse } from './placeHouse';

const SINGLE_STOREY: readonly HouseTemplate[] = HOUSE_TEMPLATES.filter((t) => t.storeys === 1);
const ORIGIN_CX = 13;
const ORIGIN_CY = 7;

function placedFor(t: HouseTemplate): PlacedHouse {
  return placeHouse(t, ORIGIN_CX, ORIGIN_CY);
}

describe('placeHouse — single-storey generator', () => {
  it('covers the single-storey library (ranch/bungalow/garage), excludes the 2-storey colonial', () => {
    expect(SINGLE_STOREY.length).toBeGreaterThanOrEqual(4);
    expect(SINGLE_STOREY.some((t) => t.id === 'colonial-2storey')).toBe(false);
  });

  it('throws when a template has no storey-0 plan only if storeys is wrong (sanity: all 1-storey have one)', () => {
    for (const t of SINGLE_STOREY) expect(() => placeHouse(t, 0, 0)).not.toThrow();
  });
});

describe.each(SINGLE_STOREY.map((t) => [t.id, t] as const))('placeHouse(%s)', (_id, template) => {
  const placed = placedFor(template);
  const { w, d } = template.footprint;

  it('rooms cover every footprint cell exactly once, in world coordinates', () => {
    expect(placed.rooms.length).toBe(w * d);
    const seen = new Set<string>();
    for (const c of placed.rooms) {
      const lx = c.cx - ORIGIN_CX;
      const ly = c.cy - ORIGIN_CY;
      expect(lx).toBeGreaterThanOrEqual(0);
      expect(ly).toBeGreaterThanOrEqual(0);
      expect(lx).toBeLessThan(w);
      expect(ly).toBeLessThan(d);
      seen.add(`${c.cx},${c.cy}`);
      // the room tag agrees with the template room bounds
      expect(cellInRoom({ cx: lx, cy: ly }, template.levels[0]!.rooms[c.roomId]!)).toBe(true);
      expect(template.levels[0]!.rooms[c.roomId]!.type).toBe(c.type);
    }
    expect(seen.size).toBe(w * d);
  });

  it('roomAt resolves inside the footprint and returns null outside', () => {
    expect(placed.roomAt(ORIGIN_CX, ORIGIN_CY)).not.toBeNull();
    expect(placed.roomAt(ORIGIN_CX + w - 1, ORIGIN_CY + d - 1)).not.toBeNull();
    expect(placed.roomAt(ORIGIN_CX - 1, ORIGIN_CY)).toBeNull();
    expect(placed.roomAt(ORIGIN_CX + w, ORIGIN_CY)).toBeNull();
    // roomAt agrees with the rooms array
    for (const c of placed.rooms) {
      const r = placed.roomAt(c.cx, c.cy);
      expect(r).not.toBeNull();
      expect(r!.roomId).toBe(c.roomId);
      expect(r!.type).toBe(c.type);
    }
  });

  it('interior wall edges sit exactly between two DIFFERENT rooms; exterior edges on the boundary', () => {
    for (const e of placed.wallEdges) {
      if (e.kind === 'interior') {
        // both sides are real, in-footprint room cells with DIFFERENT room ids
        expect(e.outerCx).not.toBeNull();
        expect(e.outerCy).not.toBeNull();
        const inner = placed.roomAt(e.innerCx, e.innerCy);
        const outer = placed.roomAt(e.outerCx!, e.outerCy!);
        expect(inner).not.toBeNull();
        expect(outer).not.toBeNull();
        expect(inner!.roomId).toBe(e.innerRoom);
        expect(outer!.roomId).toBe(e.outerRoom);
        expect(e.innerRoom).not.toBe(e.outerRoom);
      } else {
        // exterior: inner cell is in-footprint, the OTHER side is outside the footprint
        expect(e.outerCx).toBeNull();
        expect(e.outerCy).toBeNull();
        expect(e.outerRoom).toBeNull();
        expect(placed.roomAt(e.innerCx, e.innerCy)).not.toBeNull();
      }
      // the two cells the edge separates are orthogonally adjacent, and `along` matches the axis they share
      if (e.kind === 'interior') {
        const dx = Math.abs(e.outerCx! - e.innerCx);
        const dy = Math.abs(e.outerCy! - e.innerCy);
        expect(dx + dy).toBe(1);
        expect(e.along).toBe(dx === 1 ? 'z' : 'x');
      }
    }
  });

  it('wall edges are deduped — each canonical key appears once', () => {
    const keys = placed.wallEdges.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every cell-pair that straddles a room boundary OR the footprint edge has exactly one wall edge', () => {
    // independently recompute the expected wall-edge count and cross-check.
    const roomAtL = (lx: number, ly: number): number => {
      const r = placed.roomAt(ORIGIN_CX + lx, ORIGIN_CY + ly);
      return r ? r.roomId : -1;
    };
    let expected = 0;
    for (let ly = 0; ly < d; ly++) {
      for (let lx = 0; lx < w; lx++) {
        const here = roomAtL(lx, ly);
        // east + south neighbours (each interior seam counted once); plus boundary on all four sides.
        if (lx + 1 >= w) expected++; // east boundary
        else if (roomAtL(lx + 1, ly) !== here) expected++; // east interior seam
        if (ly + 1 >= d) expected++; // south boundary
        else if (roomAtL(lx, ly + 1) !== here) expected++; // south interior seam
        if (lx === 0) expected++; // west boundary
        if (ly === 0) expected++; // north boundary
      }
    }
    expect(placed.wallEdges.length).toBe(expected);
  });

  it('every door lands on a real wall edge and the template validator accepts it', () => {
    const plan = template.levels[0]!;
    expect(placed.doors.length).toBe(plan.doors.length);
    for (const door of placed.doors) {
      // the edge exists in the wall-edge set (same instance, by key)
      expect(placed.wallEdges.some((e) => e.key === door.edge.key)).toBe(true);
      // an exterior door opens an exterior edge; an interior door opens an interior edge
      expect(door.edge.kind).toBe(door.exterior ? 'exterior' : 'interior');
    }
    // and the underlying template doors all validate
    for (const tdoor of plan.doors) {
      expect(doorPlacementValid(tdoor, plan.rooms, template.footprint)).toBe(true);
    }
  });

  it('exactly one FRONT door, on a living or hall room, opening to the outside', () => {
    const fronts = placed.doors.filter((dr) => dr.front);
    expect(fronts.length).toBe(1);
    const front = fronts[0]!;
    expect(front.exterior).toBe(true);
    expect(front.edge.kind).toBe('exterior');
    const type = template.levels[0]!.rooms[front.fromRoom]!.type;
    expect(type === 'living' || type === 'hall').toBe(true);
  });

  it('every window lands on an exterior wall edge of its room (validator agrees)', () => {
    const plan = template.levels[0]!;
    expect(placed.windows.length).toBe(plan.windows.length);
    const slots = new Set<number>();
    for (const win of placed.windows) {
      expect(win.edge.kind).toBe('exterior');
      expect(placed.wallEdges.some((e) => e.key === win.edge.key)).toBe(true);
      // the window cell belongs to the room it names
      expect(placed.roomAt(win.cx, win.cy)!.roomId).toBe(win.room);
      slots.add(win.slot);
    }
    expect(slots.size).toBe(placed.windows.length); // unique deterministic slots
    for (const twin of plan.windows) {
      expect(windowOnExterior(twin, plan.rooms, template.footprint)).toBe(true);
    }
  });
});

describe('placeHouse — determinism + translation', () => {
  it('is deterministic: same template + origin ⇒ identical placement (V26)', () => {
    const t = SINGLE_STOREY[0]!;
    const a = placeHouse(t, 4, 9);
    const b = placeHouse(t, 4, 9);
    expect(JSON.stringify(stripFns(a))).toBe(JSON.stringify(stripFns(b)));
  });

  it('translates cleanly: shifting the origin shifts every cell/edge by the same delta', () => {
    const t = SINGLE_STOREY[0]!;
    const a = placeHouse(t, 0, 0);
    const b = placeHouse(t, 10, 20);
    expect(a.rooms.length).toBe(b.rooms.length);
    expect(a.wallEdges.length).toBe(b.wallEdges.length);
    for (let i = 0; i < a.rooms.length; i++) {
      expect(b.rooms[i]!.cx - a.rooms[i]!.cx).toBe(10);
      expect(b.rooms[i]!.cy - a.rooms[i]!.cy).toBe(20);
      expect(b.rooms[i]!.roomId).toBe(a.rooms[i]!.roomId);
    }
  });
});

function stripFns(h: PlacedHouse): unknown {
  // Destructure-to-omit the function props (`roomAt`/`template`) via rest-spread; the named bindings are
  // intentionally unused (eslint's no-unused-vars lacks ignoreRestSiblings here).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { roomAt: _omit, template: _t, ...rest } = h;
  return rest;
}
