// P1a — furniture placement tests. Pure + deterministic; no three/GPU/sim. For every RoomType we assert the
// layout is legal (in-bounds, non-overlapping, never on a door cell — via furnitureFits), that container-bearing
// rooms include their expected CONTAINER piece(s) wired to the right LootSource, that placement is deterministic
// (same seed ⇒ identical, different seed ⇒ may differ), and that no doorway is ever sealed (a flood-fill from the
// door over non-furniture cells reaches every non-furniture cell — furnitureLeavesPathClear).

import { describe, expect, it } from 'vitest';
import type { CellRect, Edge, RoomType } from './houseTemplates';
import type { LootSource } from '@/game/inventory/loot';
import {
  furnishRoom,
  furnitureFits,
  furnitureLeavesPathClear,
  type FurnishRoomArgs,
  type FurnitureKind,
  type FurniturePiece,
} from './furnishRoom';

const rect = (minCx: number, minCy: number, maxCx: number, maxCy: number): CellRect => ({
  minCx,
  minCy,
  maxCx,
  maxCy,
});

// A representative, adequately-sized room per type, each with a door on a boundary cell and a couple of
// exterior windows — mirrors the kind of rect the placer receives from houseTemplates / PlacedHouse.
interface Fixture {
  readonly type: RoomType;
  readonly args: FurnishRoomArgs;
  /** Container kinds the room MUST contain, each with its expected LootSource. */
  readonly mustContain: ReadonlyArray<{ kind: FurnitureKind; source: LootSource }>;
}

const FIXTURES: readonly Fixture[] = [
  {
    type: 'kitchen',
    args: {
      type: 'kitchen',
      bounds: rect(4, 3, 6, 5),
      seed: 7,
      doorCells: [{ cx: 4, cy: 3 }],
      windows: [{ edge: 's', cell: { cx: 5, cy: 5 } }],
      exteriorEdges: ['s', 'e'],
    },
    mustContain: [{ kind: 'fridge', source: 'kitchen' }],
  },
  {
    type: 'bedroom',
    args: {
      type: 'bedroom',
      bounds: rect(0, 0, 2, 3),
      seed: 11,
      doorCells: [{ cx: 2, cy: 1 }],
      windows: [{ edge: 'n', cell: { cx: 1, cy: 0 } }],
      exteriorEdges: ['n', 'w'],
    },
    mustContain: [
      { kind: 'dresser', source: 'bedroom' },
      { kind: 'wardrobe', source: 'wardrobe' },
    ],
  },
  {
    type: 'bathroom',
    args: {
      type: 'bathroom',
      bounds: rect(0, 2, 2, 3),
      seed: 23,
      doorCells: [{ cx: 2, cy: 2 }],
      windows: [{ edge: 'w', cell: { cx: 0, cy: 3 } }],
      exteriorEdges: ['w', 's'],
    },
    mustContain: [{ kind: 'medicineCabinet', source: 'bathroom' }],
  },
  {
    type: 'living',
    args: {
      type: 'living',
      bounds: rect(0, 0, 2, 2),
      seed: 31,
      doorCells: [{ cx: 2, cy: 1 }],
      windows: [{ edge: 'n', cell: { cx: 1, cy: 0 } }],
      exteriorEdges: ['n', 'w'],
    },
    mustContain: [{ kind: 'bookshelf', source: 'bedroom' }],
  },
  {
    type: 'dining',
    args: {
      type: 'dining',
      bounds: rect(3, 0, 5, 2),
      seed: 41,
      doorCells: [{ cx: 3, cy: 1 }],
      windows: [{ edge: 'n', cell: { cx: 4, cy: 0 } }],
      exteriorEdges: ['n', 'e'],
    },
    mustContain: [{ kind: 'sideboard', source: 'kitchen' }],
  },
  {
    type: 'hall',
    args: {
      type: 'hall',
      bounds: rect(3, 0, 3, 4),
      seed: 53,
      doorCells: [{ cx: 3, cy: 0 }],
      windows: [],
      exteriorEdges: [],
    },
    mustContain: [],
  },
  {
    type: 'garage',
    args: {
      type: 'garage',
      bounds: rect(6, 0, 8, 2),
      seed: 61,
      doorCells: [{ cx: 7, cy: 0 }],
      windows: [],
      exteriorEdges: ['e', 'w'],
    },
    mustContain: [
      { kind: 'shelving', source: 'garage' },
      { kind: 'gunCabinet', source: 'gunCabinet' }, // T139: weapons/ammo source placed in garages
    ],
  },
  {
    type: 'closet',
    args: {
      type: 'closet',
      bounds: rect(2, 4, 2, 5),
      seed: 71,
      doorCells: [{ cx: 2, cy: 4 }],
      windows: [],
      exteriorEdges: [],
    },
    mustContain: [{ kind: 'shelving', source: 'wardrobe' }],
  },
  {
    type: 'laundry',
    args: {
      type: 'laundry',
      bounds: rect(0, 0, 1, 2),
      seed: 83,
      doorCells: [{ cx: 1, cy: 0 }],
      windows: [],
      exteriorEdges: ['w'],
    },
    mustContain: [{ kind: 'washer', source: 'wardrobe' }],
  },
];

const has = (pieces: readonly FurniturePiece[], kind: FurnitureKind, source: LootSource): boolean =>
  pieces.some((p) => p.kind === kind && p.container === source);

describe('furnishRoom — per room type', () => {
  for (const fx of FIXTURES) {
    describe(fx.type, () => {
      const pieces = furnishRoom(fx.args);

      it('produces at least one piece for an adequately-sized room', () => {
        expect(pieces.length).toBeGreaterThan(0);
      });

      it('is in-bounds, non-overlapping, and never on a door cell (furnitureFits)', () => {
        expect(furnitureFits(pieces, fx.args.bounds, fx.args.doorCells)).toBe(true);
      });

      it('keeps a walkable path — no doorway is sealed (furnitureLeavesPathClear)', () => {
        expect(furnitureLeavesPathClear(pieces, fx.args.bounds, fx.args.doorCells)).toBe(true);
      });

      it('does not place a piece on any door cell', () => {
        const doorKeys = new Set(fx.args.doorCells.map((c) => `${c.cx},${c.cy}`));
        for (const p of pieces) expect(doorKeys.has(`${p.cell.cx},${p.cell.cy}`)).toBe(false);
      });

      it('includes its expected CONTAINER pieces with the right LootSource', () => {
        for (const want of fx.mustContain) {
          expect(has(pieces, want.kind, want.source)).toBe(true);
        }
      });

      it('keeps every container piece off a window-blocking tall slot', () => {
        // tall containers (wardrobe/medicineCabinet/shelving/fridge/bookshelf) must not sit on a windowed wall.
        const winKeys = new Set(fx.args.windows.map((w) => `${w.cell.cx},${w.cell.cy}|${w.edge}`));
        for (const p of pieces) {
          // back-edge = opposite the facing; check the piece isn't backing onto a window.
          const back: Record<Edge, Edge> = { n: 's', s: 'n', e: 'w', w: 'e' };
          const tallKinds: FurnitureKind[] = ['wardrobe', 'medicineCabinet', 'shelving', 'fridge', 'bookshelf'];
          if (!tallKinds.includes(p.kind)) continue;
          expect(winKeys.has(`${p.cell.cx},${p.cell.cy}|${back[p.facing]}`)).toBe(false);
        }
      });
    });
  }
});

describe('furnishRoom — wall pieces face into the room', () => {
  it('a wall piece never backs onto open interior (its anchor sits on the room boundary it faces away from)', () => {
    const args = FIXTURES.find((f) => f.type === 'bedroom')!.args;
    const pieces = furnishRoom(args);
    const bed = pieces.find((p) => p.kind === 'bed');
    expect(bed).toBeDefined();
    // The bed's back is opposite its facing; that back edge must be a real room-boundary side.
    const b = args.bounds;
    const back: Record<Edge, Edge> = { n: 's', s: 'n', e: 'w', w: 'e' };
    const backEdge = back[bed!.facing];
    const onBoundary =
      (backEdge === 'n' && bed!.cell.cy === b.minCy) ||
      (backEdge === 's' && bed!.cell.cy === b.maxCy) ||
      (backEdge === 'e' && bed!.cell.cx === b.maxCx) ||
      (backEdge === 'w' && bed!.cell.cx === b.minCx);
    expect(onBoundary).toBe(true);
  });
});

describe('furnishRoom — determinism (V26)', () => {
  it('same seed + room ⇒ identical layout', () => {
    const args = FIXTURES.find((f) => f.type === 'kitchen')!.args;
    const a = furnishRoom(args);
    const b = furnishRoom(args);
    expect(b).toEqual(a);
  });

  it('different seed ⇒ may differ (at least one room shifts a piece)', () => {
    const base = FIXTURES.find((f) => f.type === 'kitchen')!.args;
    let differs = false;
    for (let s = 1; s <= 12 && !differs; s++) {
      const a = furnishRoom({ ...base, seed: s });
      const b = furnishRoom({ ...base, seed: s + 100 });
      if (JSON.stringify(a) !== JSON.stringify(b)) differs = true;
    }
    expect(differs).toBe(true);
  });

  it('the same house seed yields varied layouts across distinct rooms (seed mixed with bounds)', () => {
    const a = furnishRoom({
      type: 'bedroom',
      bounds: rect(0, 0, 2, 3),
      seed: 999,
      doorCells: [{ cx: 2, cy: 1 }],
      windows: [],
      exteriorEdges: ['n', 'w'],
    });
    const b = furnishRoom({
      type: 'bedroom',
      bounds: rect(7, 0, 8, 2),
      seed: 999,
      doorCells: [{ cx: 7, cy: 0 }],
      windows: [],
      exteriorEdges: ['n', 'e'],
    });
    // Different bounds + same seed should not produce byte-identical local anchors for every piece.
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });
});

describe('furnishRoom — edge cases', () => {
  it('throws when a window is declared on a non-exterior edge (malformed input is surfaced)', () => {
    expect(() =>
      furnishRoom({
        type: 'bedroom',
        bounds: rect(0, 0, 2, 3),
        seed: 1,
        doorCells: [],
        windows: [{ edge: 's', cell: { cx: 1, cy: 3 } }],
        exteriorEdges: ['n'], // 's' is NOT exterior here
      }),
    ).toThrow();
  });

  it('a fully-doored single-cell room places nothing (never furnishes a doorway)', () => {
    const pieces = furnishRoom({
      type: 'closet',
      bounds: rect(2, 5, 2, 5),
      seed: 5,
      doorCells: [{ cx: 2, cy: 5 }],
      windows: [],
      exteriorEdges: [],
    });
    expect(pieces).toHaveLength(0);
    expect(furnitureFits(pieces, rect(2, 5, 2, 5), [{ cx: 2, cy: 5 }])).toBe(true);
  });

  it('furnitureFits rejects an out-of-bounds / overlapping / on-door layout', () => {
    const b = rect(0, 0, 2, 2);
    const piece = (cx: number, cy: number): FurniturePiece => ({
      kind: 'chair',
      cell: { cx, cy },
      footprint: { w: 1, d: 1 },
      facing: 'n',
      container: null,
    });
    expect(furnitureFits([piece(3, 0)], b, [])).toBe(false); // OOB
    expect(furnitureFits([piece(1, 1), piece(1, 1)], b, [])).toBe(false); // overlap
    expect(furnitureFits([piece(0, 0)], b, [{ cx: 0, cy: 0 }])).toBe(false); // on a door
  });
});
