// T14 tests — chunk streaming lifecycle: valid/invalid transitions, disposal on evict (V24).

import { describe, it, expect } from 'vitest';
import { ChunkStreamer, isValidTransition } from './chunkStreaming';

describe('chunk streaming lifecycle (T14/V24)', () => {
  it('walks the full warm-up pipeline through valid transitions', () => {
    const s = new ChunkStreamer();
    s.track(1);
    expect(s.stateOf(1)).toBe('unloaded');
    const path = ['abstract', 'meta', 'cpu-load', 'sim-active', 'visual', 'high-detail'] as const;
    for (const next of path) s.transition(1, next);
    expect(s.stateOf(1)).toBe('high-detail');
  });

  it('rejects an illegal transition (no silent state corruption)', () => {
    const s = new ChunkStreamer();
    s.track(1);
    expect(() => s.transition(1, 'sim-active')).toThrow(/illegal/); // can't skip from unloaded
    s.transition(1, 'abstract');
    expect(() => s.transition(1, 'high-detail')).toThrow(/illegal/);
  });

  it('cooling -> persisted-evicted disposes every registered resource (V24)', () => {
    const s = new ChunkStreamer();
    s.track(2);
    let disposedA = false;
    let disposedB = false;
    // warm up to high-detail and register resources along the way
    s.transition(2, 'abstract');
    s.transition(2, 'meta');
    s.transition(2, 'cpu-load');
    s.registerResource(2, 'geometry', () => { disposedA = true; });
    s.transition(2, 'sim-active');
    s.transition(2, 'visual');
    s.registerResource(2, 'texture', () => { disposedB = true; });
    expect(s.resourceCount(2)).toBe(2);
    s.transition(2, 'cooling', 100);
    s.transition(2, 'persisted-evicted');
    expect(disposedA).toBe(true);
    expect(disposedB).toBe(true);
    expect(s.resourceCount(2)).toBe(0);
  });

  it('readyToEvict respects the cooling dwell time', () => {
    const s = new ChunkStreamer();
    s.track(3);
    s.transition(3, 'abstract');
    s.transition(3, 'meta');
    s.transition(3, 'cpu-load');
    s.transition(3, 'cooling', 1000);
    expect(s.readyToEvict(3, 1000)).toBe(false);
    expect(s.readyToEvict(3, 1000 + s.settings.coolingTicks)).toBe(true);
  });

  it('cooling can re-warm to sim-active (camera returned)', () => {
    const s = new ChunkStreamer();
    s.track(4);
    s.transition(4, 'abstract');
    s.transition(4, 'meta');
    s.transition(4, 'cpu-load');
    s.transition(4, 'sim-active');
    s.transition(4, 'cooling', 5);
    s.transition(4, 'sim-active'); // re-warm
    expect(s.stateOf(4)).toBe('sim-active');
  });

  it('transition table is symmetric with isValidTransition', () => {
    expect(isValidTransition('unloaded', 'abstract')).toBe(true);
    expect(isValidTransition('unloaded', 'visual')).toBe(false);
    expect(isValidTransition('persisted-evicted', 'unloaded')).toBe(true);
  });
});
