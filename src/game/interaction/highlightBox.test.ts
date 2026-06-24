// T60/V29 — the pure target→highlight-box transform: per-kind TIGHT boxes that hug the real mesh (thin door/
// window/wall on the wall, window lifted to its sill, low corpse box, cabinet-sized container), oriented to the
// wall via rotationY.
import { describe, it, expect } from 'vitest';
import { highlightBoxFor, type HighlightDims, type InteractionTargetWorld } from './nearest';

const dims: HighlightDims = {
  navCellSize: 2,
  wallHeightMeters: 3,
  thinMeters: 0.16,
  corpseSizeMeters: 0.7,
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
    expect(box.rotationY).toBe(0);
  });

  it('a door is a THIN leaf on the wall (not a fat cell cube), oriented to the wall run', () => {
    const box = highlightBoxFor({ kind: 'door', x: 1, z: 2, label: 'Door', orientationRad: Math.PI / 2 }, dims);
    expect(box.sizeX).toBeCloseTo(1.7); // ~0.85 cell wide along the run
    expect(box.sizeY).toBeCloseTo(2.55); // ~0.85 wall height
    expect(box.sizeZ).toBeCloseTo(0.16); // thin on the wall normal
    expect(box.y).toBeCloseTo(1.275); // on the floor
    expect(box.rotationY).toBeCloseTo(Math.PI / 2);
  });

  it('a window is a thin pane LIFTED to its sill, matching the REAL opening (T115)', () => {
    const box = highlightBoxFor({ kind: 'window', x: 1, z: 2, label: 'Window' }, dims);
    expect(box.sizeX).toBeCloseTo(1.4); // 0.7 cell wide along the run (WINDOW_SPAN_FRACTION)
    expect(box.sizeY).toBeCloseTo(1.2); // 0.4 wall-height tall (WINDOW_HEIGHT_FRACTION)
    expect(box.sizeZ).toBeCloseTo(0.16);
    // sill (0.3·3 = 0.9, WINDOW_SILL_FRACTION) + half height (0.6) → centre 1.5 wall-height — hugs the real
    // pane (centre 0.5·wallHeight), NOT the old 1.95 that floated above it (T115).
    expect(box.y).toBeCloseTo(1.5);
    expect(box.y).toBeCloseTo(dims.wallHeightMeters * 0.5);
    expect(box.rotationY).toBe(0); // no orientation given → axis-aligned
  });

  it('a window box hugs the wall when oriented (thin axis = wall normal, T115)', () => {
    const box = highlightBoxFor({ kind: 'window', x: 1, z: 2, label: 'Window', orientationRad: Math.PI / 2 }, dims);
    expect(box.rotationY).toBeCloseTo(Math.PI / 2);
    expect(box.sizeX).toBeCloseTo(1.4); // wide axis (wall run) before rotation
    expect(box.sizeZ).toBeCloseTo(0.16); // thin axis (wall normal) before rotation
  });

  it('a corpse is a low body box on the ground', () => {
    const box = highlightBoxFor({ kind: 'corpse', x: 1, z: 2, label: 'Corpse' }, dims);
    expect(box.sizeX).toBeCloseTo(0.7);
    expect(box.sizeY).toBeCloseTo(0.42);
    expect(box.y).toBeCloseTo(0.21);
  });
});
