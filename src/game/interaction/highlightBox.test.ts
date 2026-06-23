// T60/V29 — the pure target→highlight-box transform: a container is sized to the cabinet dims (so the outline
// hugs the cupboard mesh), every other kind gets a one-cell footprint at the configured height, and the box
// rests on the floor (centre at half its height).
import { describe, it, expect } from 'vitest';
import { highlightBoxFor, type HighlightDims, type InteractionTargetWorld } from './nearest';

const dims: HighlightDims = {
  navCellSize: 2,
  defaultHeightMeters: 2.2,
  cupboardWidthMeters: 1,
  cupboardDepthMeters: 0.6,
  cupboardHeightMeters: 1.1,
};

describe('highlightBoxFor (T60/V29)', () => {
  it('sizes a container box to the cabinet dims, resting on the floor', () => {
    const target: InteractionTargetWorld = { kind: 'container', x: 5, z: 7, label: 'Kitchen Cupboard' };
    const box = highlightBoxFor(target, dims);
    expect(box.kind).toBe('container');
    expect([box.sizeX, box.sizeY, box.sizeZ]).toEqual([1, 1.1, 0.6]);
    expect([box.x, box.z]).toEqual([5, 7]);
    expect(box.y).toBeCloseTo(0.55); // half its height — standing on the floor
  });

  it('gives a door/window/wall a one-cell footprint at the configured height', () => {
    for (const kind of ['door', 'window', 'structure'] as const) {
      const box = highlightBoxFor({ kind, x: 1, z: 2, label: kind }, dims);
      expect(box.sizeX).toBe(2);
      expect(box.sizeZ).toBe(2);
      expect(box.sizeY).toBe(2.2);
      expect(box.y).toBeCloseTo(1.1);
    }
  });
});
