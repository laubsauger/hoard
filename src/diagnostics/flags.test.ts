// T35 tests — debug control flag toggles, force-LOD validation, reset.

import { describe, it, expect } from 'vitest';
import { DebugFlagState, DEFAULT_DEBUG_FLAGS } from './flags';

describe('DebugFlagState', () => {
  it('defaults all booleans off and force-LOD auto (null)', () => {
    const s = new DebugFlagState();
    expect(s.get()).toEqual(DEFAULT_DEBUG_FLAGS);
    expect(s.get().forceLodLevel).toBeNull();
  });

  it('toggles a single boolean control without touching others', () => {
    const s = new DebugFlagState();
    s.toggle('freezeTiers');
    expect(s.get().freezeTiers).toBe(true);
    expect(s.get().showSpatialGrids).toBe(false);
    s.toggle('freezeTiers');
    expect(s.get().freezeTiers).toBe(false);
  });

  it('set() forces a boolean value explicitly', () => {
    const s = new DebugFlagState();
    s.set('visualizeFlowFields', true);
    expect(s.get().visualizeFlowFields).toBe(true);
  });

  it('pins and clears force-LOD; rejects negative / non-integer', () => {
    const s = new DebugFlagState();
    s.setForceLod(2);
    expect(s.get().forceLodLevel).toBe(2);
    s.setForceLod(null);
    expect(s.get().forceLodLevel).toBeNull();
    expect(() => s.setForceLod(-1)).toThrow();
    expect(() => s.setForceLod(1.5)).toThrow();
  });

  it('reset() restores defaults', () => {
    const s = new DebugFlagState();
    s.toggle('inspectDirtyNavTiles');
    s.setForceLod(0);
    s.reset();
    expect(s.get()).toEqual(DEFAULT_DEBUG_FLAGS);
  });

  it('exposes exactly the boolean control keys', () => {
    expect(DebugFlagState.booleanKeys()).toEqual([
      'freezeTiers',
      'showSpatialGrids',
      'visualizeFlowFields',
      'inspectDirtyNavTiles',
      'showStructuralCells',
    ]);
  });
});
