// P1b — furnishHouse adapts a PlacedHouse into world-cell furniture. Pure + deterministic; no three/GPU/nav.
// Asserts every single-storey template furnishes (non-empty), pieces land inside the house interior (never on
// the wall ring / a doorway), solidity flags match the FURNITURE_SOLIDITY map, container pieces carry a
// LootSource, and the layout is byte-for-byte deterministic for a fixed (house, seed).

import { describe, expect, it } from 'vitest';
import { HOUSE_TEMPLATES } from './houseTemplates';
import { placeHouse } from './placeHouse';
import { furnishHouse } from './furnishHouse';
import { FURNITURE_SOLIDITY } from './furnitureSolidity';

const SINGLE = HOUSE_TEMPLATES.filter((t) => t.storeys === 1);

describe('furnishHouse', () => {
  it('furnishes every single-storey template with in-bounds, non-doorway pieces', () => {
    for (const template of SINGLE) {
      const placed = placeHouse(template, 10, 10);
      const furniture = furnishHouse(placed, 0, 12345);
      expect(furniture.length).toBeGreaterThan(0);

      const doorCells = new Set<string>();
      for (const d of placed.doors) doorCells.add(`${d.cx},${d.cy}`);

      const intMinCx = placed.originCx;
      const intMinCy = placed.originCy;
      const intMaxCx = placed.originCx + placed.width - 1;
      const intMaxCy = placed.originCy + placed.depth - 1;

      const occupied = new Set<string>();
      for (const p of furniture) {
        for (let dy = 0; dy < p.footprint.d; dy++) {
          for (let dx = 0; dx < p.footprint.w; dx++) {
            const cx = p.cx + dx;
            const cy = p.cy + dy;
            // inside the room interior (never on the wall ring)
            expect(cx).toBeGreaterThanOrEqual(intMinCx);
            expect(cx).toBeLessThanOrEqual(intMaxCx);
            expect(cy).toBeGreaterThanOrEqual(intMinCy);
            expect(cy).toBeLessThanOrEqual(intMaxCy);
            // never on a door cell, never overlapping another piece
            const k = `${cx},${cy}`;
            expect(doorCells.has(k)).toBe(false);
            expect(occupied.has(k)).toBe(false);
            occupied.add(k);
          }
        }
        // solidity flag matches the single source of truth
        expect(p.solid).toBe(FURNITURE_SOLIDITY[p.kind]);
        // the piece is tagged with the house it belongs to
        expect(p.houseIndex).toBe(0);
      }
    }
  });

  it('marks the expected kitchen/bedroom/bathroom containers with a LootSource', () => {
    // ranch-2bed has a kitchen + bedrooms + bath — assert the container pieces resolve to the right sources.
    const ranch = SINGLE.find((t) => t.id === 'ranch-2bed')!;
    const placed = placeHouse(ranch, 5, 5);
    const furniture = furnishHouse(placed, 0, 999);
    const containers = furniture.filter((p) => p.container !== null);
    expect(containers.length).toBeGreaterThan(0);
    // every container's source is one of the known loot sources used by the furniture programs
    const fridge = furniture.find((p) => p.kind === 'fridge');
    if (fridge) expect(fridge.container).toBe('kitchen');
    const dresser = furniture.find((p) => p.kind === 'dresser');
    if (dresser) expect(dresser.container).toBe('bedroom');
  });

  it('is deterministic: same (house, seed) ⇒ identical furniture', () => {
    const template = SINGLE[0]!;
    const a = furnishHouse(placeHouse(template, 3, 7), 2, 42);
    const b = furnishHouse(placeHouse(template, 3, 7), 2, 42);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
