// T109 / V73 — fog-of-war model: the three states (unexplored/explored/visible), their overlay dim levels, and
// the allocation-free grid whose VISITED memory persists while the per-frame VISIBLE set is cleared each frame.

import { describe, it, expect } from 'vitest';
import { fogCellState, fogDim, FogOfWarGrid, type FogDimConfig } from './fogOfWar';

const DIMS: FogDimConfig = { exploredDim: 0.5, unexploredDim: 0.85 };

describe('fogCellState (V73)', () => {
  it('never visited, not visible → unexplored', () => {
    expect(fogCellState(false, false)).toBe('unexplored');
  });
  it('visited but not visible now → explored (memory)', () => {
    expect(fogCellState(true, false)).toBe('explored');
  });
  it('visible this frame → visible (regardless of visited)', () => {
    expect(fogCellState(true, true)).toBe('visible');
    expect(fogCellState(false, true)).toBe('visible');
  });
});

describe('fogDim (V73)', () => {
  it('visible cells are fully clear (0 overlay)', () => {
    expect(fogDim('visible', DIMS)).toBe(0);
  });
  it('explored is the dim memory layer, unexplored is the darkest', () => {
    expect(fogDim('explored', DIMS)).toBe(0.5);
    expect(fogDim('unexplored', DIMS)).toBe(0.85);
    expect(fogDim('unexplored', DIMS)).toBeGreaterThan(fogDim('explored', DIMS));
  });
});

describe('FogOfWarGrid (V73)', () => {
  it('starts fully unexplored', () => {
    const g = new FogOfWarGrid(4, 3);
    expect(g.state(0, 0)).toBe('unexplored');
    expect(g.isVisited(2, 2)).toBe(false);
    expect(g.isVisible(2, 2)).toBe(false);
    expect(g.dimAt(2, 2, DIMS)).toBe(DIMS.unexploredDim);
  });

  it('markVisible sets both VISIBLE (this frame) and VISITED (forever)', () => {
    const g = new FogOfWarGrid(4, 3);
    g.markVisible(1, 1);
    expect(g.isVisible(1, 1)).toBe(true);
    expect(g.isVisited(1, 1)).toBe(true);
    expect(g.state(1, 1)).toBe('visible');
    expect(g.dimAt(1, 1, DIMS)).toBe(0);
  });

  it('beginFrame clears VISIBLE but keeps VISITED → a once-seen cell becomes EXPLORED memory', () => {
    const g = new FogOfWarGrid(4, 3);
    g.markVisible(1, 1);
    g.beginFrame(); // next frame: the cell is no longer in view
    expect(g.isVisible(1, 1)).toBe(false);
    expect(g.isVisited(1, 1)).toBe(true);
    expect(g.state(1, 1)).toBe('explored');
    expect(g.dimAt(1, 1, DIMS)).toBe(DIMS.exploredDim);
    // A cell that was never seen is still unexplored.
    expect(g.state(0, 0)).toBe('unexplored');
  });

  it('re-seeing an explored cell makes it visible again', () => {
    const g = new FogOfWarGrid(4, 3);
    g.markVisible(2, 0);
    g.beginFrame();
    expect(g.state(2, 0)).toBe('explored');
    g.markVisible(2, 0);
    expect(g.state(2, 0)).toBe('visible');
  });

  it('rejects non-positive dimensions + out-of-bounds cells (mapping bug, not a clamp)', () => {
    expect(() => new FogOfWarGrid(0, 3)).toThrow();
    expect(() => new FogOfWarGrid(4, -1)).toThrow();
    expect(() => new FogOfWarGrid(2.5, 3)).toThrow();
    const g = new FogOfWarGrid(4, 3);
    expect(() => g.markVisible(4, 0)).toThrow();
    expect(() => g.state(0, 3)).toThrow();
    expect(() => g.isVisited(-1, 0)).toThrow();
  });
});
