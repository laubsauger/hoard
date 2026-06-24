// T113 — unit tests for the pure selection-index math + the store's clamp-on-verb-count-change behaviour.

import { describe, expect, it } from 'vitest';
import { cycleIndex, clampIndex, createInteractionSelectStore } from './interactionSelect';

describe('cycleIndex', () => {
  it('steps forward and wraps past the end', () => {
    expect(cycleIndex(0, 3, 1)).toBe(1);
    expect(cycleIndex(1, 3, 1)).toBe(2);
    expect(cycleIndex(2, 3, 1)).toBe(0); // wrap
  });

  it('steps backward and wraps past the start', () => {
    expect(cycleIndex(2, 3, -1)).toBe(1);
    expect(cycleIndex(0, 3, -1)).toBe(2); // wrap
  });

  it('stays at 0 for a single verb and for no verbs', () => {
    expect(cycleIndex(0, 1, 1)).toBe(0);
    expect(cycleIndex(0, 1, -1)).toBe(0);
    expect(cycleIndex(0, 0, 1)).toBe(0);
    expect(cycleIndex(5, 0, -1)).toBe(0);
  });

  it('normalises an out-of-range start before cycling', () => {
    expect(cycleIndex(7, 3, 1)).toBe(2); // (7+1)%3 = 2
  });
});

describe('clampIndex', () => {
  it('keeps an in-range index', () => {
    expect(clampIndex(0, 3)).toBe(0);
    expect(clampIndex(2, 3)).toBe(2);
  });

  it('clamps an index past the live count to the last verb', () => {
    expect(clampIndex(2, 2)).toBe(1);
    expect(clampIndex(9, 3)).toBe(2);
  });

  it('clamps negatives and an empty list to 0', () => {
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(2, 0)).toBe(0);
  });
});

describe('interactionSelectStore', () => {
  it('cycles selection within the published verb count and wraps', () => {
    const store = createInteractionSelectStore();
    store.getState().setVerbCount(3);
    store.getState().cycle(1);
    expect(store.getState().selectedIndex).toBe(1);
    store.getState().cycle(1);
    store.getState().cycle(1);
    expect(store.getState().selectedIndex).toBe(0); // wrapped past end
  });

  it('clamps the selected index when the verb count shrinks (boarded → open window)', () => {
    const store = createInteractionSelectStore();
    store.getState().setVerbCount(3);
    store.getState().cycle(1);
    store.getState().cycle(1);
    expect(store.getState().selectedIndex).toBe(2);
    store.getState().setVerbCount(2); // verbs changed — fewer now
    expect(store.getState().verbCount).toBe(2);
    expect(store.getState().selectedIndex).toBe(1); // clamped to last
  });

  it('resets selection and treats count 0 as nothing selectable', () => {
    const store = createInteractionSelectStore();
    store.getState().setVerbCount(2);
    store.getState().cycle(1);
    store.getState().reset();
    expect(store.getState().selectedIndex).toBe(0);
    store.getState().setVerbCount(0);
    expect(store.getState().selectedIndex).toBe(0);
    store.getState().cycle(1); // no-op at count 0
    expect(store.getState().selectedIndex).toBe(0);
  });
});
