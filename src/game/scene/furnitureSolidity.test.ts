// Furniture nav block = the piece's ACTUAL MESH footprint, not the fat reserved cell box (the bookshelf bug).
import { describe, it, expect } from 'vitest';
import { furnitureBlockedCells, isFurnitureSolid } from './furnitureSolidity';
import type { PlacedFurniture } from './testBlock';
import type { FurnitureKind } from './furnishRoom';
import type { Edge, RoomType } from './houseTemplates';

/** A placed piece reserving a `res`×`res` cell box at (cx,cy) — the mesh sits centred in that reservation. */
function piece(kind: FurnitureKind, cx: number, cy: number, facing: Edge, res = 2): PlacedFurniture {
  return {
    kind,
    cx,
    cy,
    footprint: { w: res, d: res },
    facing,
    solid: isFurnitureSolid(kind),
    container: null,
    houseIndex: 0,
    roomId: 0,
    roomType: 'living' as RoomType,
  };
}

describe('furnitureBlockedCells — mesh footprint, not the reservation', () => {
  it('a thin bookshelf (1.0×0.4 m) blocks far fewer cells than its 2×2 reservation', () => {
    const cells = furnitureBlockedCells(piece('bookshelf', 0, 0, 's'), 1);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThan(4); // NOT the full 2×2 reserved box (the bug)
  });

  it('a big bed blocks MORE cells than a thin bookshelf at the same resolution', () => {
    const bed = furnitureBlockedCells(piece('bed', 0, 0, 's'), 1).length;
    const shelf = furnitureBlockedCells(piece('bookshelf', 0, 0, 's'), 1).length;
    expect(bed).toBeGreaterThan(shelf);
  });

  it('non-solid pieces block nothing (a chair / coffee table stays walkable)', () => {
    expect(furnitureBlockedCells(piece('chair', 0, 0, 's'), 1)).toEqual([]);
    expect(furnitureBlockedCells(piece('coffeeTable', 0, 0, 's'), 1)).toEqual([]);
  });

  it('always blocks at least the centre cell (a sub-cell piece is still an obstacle)', () => {
    expect(furnitureBlockedCells(piece('nightstand', 3, 4, 'n', 1), 2).length).toBeGreaterThanOrEqual(1);
  });

  it('orientation: facing e/w swaps the footprint vs n/s (a wide-shallow piece rotates)', () => {
    // sideboard 1.4×0.5: facing s spans wide on X (≥2 cells), thin on Z; facing e spans wide on Z, thin on X.
    const ns = furnitureBlockedCells(piece('sideboard', 0, 0, 's', 2), 1);
    const ew = furnitureBlockedCells(piece('sideboard', 0, 0, 'e', 2), 1);
    const spanX = (cs: { cx: number }[]) => new Set(cs.map((c) => c.cx)).size;
    const spanZ = (cs: { cy: number }[]) => new Set(cs.map((c) => c.cy)).size;
    expect(spanX(ns)).toBeGreaterThanOrEqual(spanZ(ns)); // wide on X when facing s
    expect(spanZ(ew)).toBeGreaterThanOrEqual(spanX(ew)); // wide on Z when facing e
  });
});
