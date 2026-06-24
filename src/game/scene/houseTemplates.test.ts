// Validation for the grounded floor-plan template library (docs/PROCEDURAL-HOUSES.md research step).
// Proves every hand-authored template is well-formed: rooms tile the footprint exactly, doors sit on real
// shared walls + connect the whole house from the front door, windows are on exterior walls only, and the
// 2-storey schema (footprint + stairs) is consistent. No GPU/sim deps — pure data + pure helpers.
import { describe, it, expect } from 'vitest';
import {
  HOUSE_TEMPLATES,
  tileCheck,
  doorGraphConnected,
  reachableFromExterior,
  doorPlacementValid,
  windowOnExterior,
  cellInRoom,
  type FloorPlan,
  type Footprint,
} from './houseTemplates';

/** Build the exact-cover map for a level: each footprint cell -> how many rooms claim it. */
function coverageCounts(plan: FloorPlan, footprint: Footprint): number[] {
  const cover = new Array<number>(footprint.w * footprint.d).fill(0);
  for (const room of plan.rooms) {
    const b = room.bounds;
    for (let cy = b.minCy; cy <= b.maxCy; cy++) {
      for (let cx = b.minCx; cx <= b.maxCx; cx++) {
        if (cx >= 0 && cx < footprint.w && cy >= 0 && cy < footprint.d) cover[cy * footprint.w + cx]! += 1;
      }
    }
  }
  return cover;
}

describe('house template library — schema is well-formed', () => {
  it('exposes 3-5 templates with unique ids', () => {
    expect(HOUSE_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    expect(HOUSE_TEMPLATES.length).toBeLessThanOrEqual(5);
    const ids = HOUSE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('storeys count matches levels.length and storey indices are sequential', () => {
    for (const t of HOUSE_TEMPLATES) {
      expect(t.levels.length).toBe(t.storeys);
      t.levels.forEach((lvl, i) => expect(lvl.storey).toBe(i));
    }
  });
});

describe.each(HOUSE_TEMPLATES.map((t) => [t.id, t] as const))('template %s', (_id, template) => {
  template.levels.forEach((plan, levelIdx) => {
    describe(`level ${levelIdx}`, () => {
      const fp = template.footprint;

      it('rooms tile the footprint exactly — no gaps, no overlaps (each cell covered once)', () => {
        expect(tileCheck(plan.rooms, fp)).toBe(true);
        const cover = coverageCounts(plan, fp);
        // every footprint cell covered by EXACTLY one room
        expect(cover.every((n) => n === 1)).toBe(true);
        expect(cover.filter((n) => n === 0)).toEqual([]); // no gaps
        expect(cover.filter((n) => n > 1)).toEqual([]); // no overlaps
        // total room area equals footprint area (cross-check)
        const area = plan.rooms.reduce((sum, room) => {
          const b = room.bounds;
          return sum + (b.maxCx - b.minCx + 1) * (b.maxCy - b.minCy + 1);
        }, 0);
        expect(area).toBe(fp.w * fp.d);
      });

      it('every room is in-bounds with min <= max', () => {
        for (const room of plan.rooms) {
          const b = room.bounds;
          expect(b.minCx).toBeLessThanOrEqual(b.maxCx);
          expect(b.minCy).toBeLessThanOrEqual(b.maxCy);
          expect(b.minCx).toBeGreaterThanOrEqual(0);
          expect(b.minCy).toBeGreaterThanOrEqual(0);
          expect(b.maxCx).toBeLessThan(fp.w);
          expect(b.maxCy).toBeLessThan(fp.d);
        }
      });

      it('every door sits on the shared wall of its two rooms (or the footprint boundary if exterior)', () => {
        for (const door of plan.doors) {
          expect(door.fromRoom).toBeGreaterThanOrEqual(0);
          expect(door.fromRoom).toBeLessThan(plan.rooms.length);
          if (door.toRoom !== null) {
            expect(door.toRoom).toBeGreaterThanOrEqual(0);
            expect(door.toRoom).toBeLessThan(plan.rooms.length);
          }
          expect(doorPlacementValid(door, plan.rooms, fp)).toBe(true);
        }
      });

      it('the room graph is connected via interior doors', () => {
        expect(doorGraphConnected(plan.rooms, plan.doors)).toBe(true);
      });

      it('every window is on an exterior wall of its room (never an interior partition)', () => {
        for (const win of plan.windows) {
          expect(win.room).toBeGreaterThanOrEqual(0);
          expect(win.room).toBeLessThan(plan.rooms.length);
          expect(windowOnExterior(win, plan.rooms, fp)).toBe(true);
          // and the window cell really belongs to the room it names
          expect(cellInRoom(win.atCell, plan.rooms[win.room]!)).toBe(true);
        }
      });
    });
  });

  it('the entry level has a front door and every room is reachable from it', () => {
    // the ground level (storey 0) carries the exterior front door
    const ground = template.levels.find((l) => l.storey === 0)!;
    const exteriorDoors = ground.doors.filter((d) => d.toRoom === null);
    expect(exteriorDoors.length).toBeGreaterThanOrEqual(1);
    // a front door must sit on a living or hall room (believable entry)
    const entryTypes = exteriorDoors.map((d) => ground.rooms[d.fromRoom]!.type);
    expect(entryTypes.some((t) => t === 'living' || t === 'hall')).toBe(true);
    expect(reachableFromExterior(ground.rooms, ground.doors)).toBe(true);
  });

  it('footprint is a believable suburban size (5-9 wide x 4-7 deep cells)', () => {
    expect(template.footprint.w).toBeGreaterThanOrEqual(5);
    expect(template.footprint.w).toBeLessThanOrEqual(9);
    expect(template.footprint.d).toBeGreaterThanOrEqual(4);
    expect(template.footprint.d).toBeLessThanOrEqual(7);
  });
});

describe('garage templates — garage has both an exterior and an interior door', () => {
  it('garage-ranch garage opens to the outside AND into the house', () => {
    const garageTemplates = HOUSE_TEMPLATES.filter((t) =>
      t.levels.some((l) => l.rooms.some((r) => r.type === 'garage')),
    );
    expect(garageTemplates.length).toBeGreaterThanOrEqual(1);
    for (const t of garageTemplates) {
      for (const plan of t.levels) {
        plan.rooms.forEach((room, idx) => {
          if (room.type !== 'garage') return;
          const fromGarage = plan.doors.filter((d) => d.fromRoom === idx || d.toRoom === idx);
          const hasExterior = fromGarage.some((d) => d.fromRoom === idx && d.toRoom === null);
          const hasInterior = fromGarage.some((d) => d.toRoom !== null);
          expect(hasExterior).toBe(true);
          expect(hasInterior).toBe(true);
        });
      }
    }
  });
});

describe('two-storey templates — multi-floor schema is consistent', () => {
  const twoStorey = HOUSE_TEMPLATES.filter((t) => t.storeys === 2);

  it('at least one two-storey template exists', () => {
    expect(twoStorey.length).toBeGreaterThanOrEqual(1);
  });

  it.each(twoStorey.map((t) => [t.id, t] as const))(
    '%s: level 0 has stairs, both levels share a footprint, top level has none',
    (_id, t) => {
      expect(t.levels.length).toBe(2);
      const [l0, l1] = t.levels;
      // level 0 carries the stairs up
      expect(l0!.stairsCell).not.toBeNull();
      // both levels share the same footprint
      // (footprint is template-level, so this is by construction — assert rooms stay inside it)
      expect(tileCheck(l0!.rooms, t.footprint)).toBe(true);
      expect(tileCheck(l1!.rooms, t.footprint)).toBe(true);
      // the stairs cell lies inside a hall room on BOTH levels (stairs sit in the hall/landing)
      const stairs = l0!.stairsCell!;
      const hallOnL0 = l0!.rooms.some((r) => r.type === 'hall' && cellInRoom(stairs, r));
      const hallOnL1 = l1!.rooms.some((r) => r.type === 'hall' && cellInRoom(stairs, r));
      expect(hallOnL0).toBe(true);
      expect(hallOnL1).toBe(true);
      // top floor has no further stairs
      expect(l1!.stairsCell).toBeNull();
      // upstairs is reachable as a connected unit (entered via the stairs, not a front door)
      expect(doorGraphConnected(l1!.rooms, l1!.doors)).toBe(true);
    },
  );
});
