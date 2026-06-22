// T5 / V12 — frame orchestration runs the correct fixed-tick count + renders once with interpolation alpha.

import { describe, it, expect } from 'vitest';
import { FixedClock } from '../../game/core';
import { FrameLoop } from './frame';

function makeLoop() {
  const clock = new FixedClock({ tickHz: 30, maxFrameSeconds: 0.25, maxCatchUpTicks: 8 });
  const simTicks: number[] = [];
  let renders = 0;
  let lastAlpha = -1;
  const loop = new FrameLoop({
    clock,
    simUpdate: (tickIndex) => simTicks.push(tickIndex),
    render: (alpha) => {
      renders += 1;
      lastAlpha = alpha;
    },
  });
  return { clock, loop, simTicks, get renders() { return renders; }, get lastAlpha() { return lastAlpha; } };
}

describe('FrameLoop (V12)', () => {
  it('runs N fixed ticks for the elapsed real time and renders once', () => {
    const h = makeLoop();
    const res = h.loop.runFrame(0.1); // 0.1s / (1/30) ~= 3 ticks
    expect(res.ticks).toBe(3);
    expect(h.simTicks.length).toBe(3);
    expect(h.renders).toBe(1);
  });

  it('passes contiguous in-order tick indices to the sim (authoritative order, V12)', () => {
    const h = makeLoop();
    h.loop.runFrame(0.1);
    expect(h.simTicks).toEqual([1, 2, 3]);
    h.loop.runFrame(0.1);
    expect(h.simTicks).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('renders with an interpolation alpha in [0,1)', () => {
    const h = makeLoop();
    h.loop.runFrame(0.05); // 1 tick + remainder ~0.0167s -> alpha ~0.5
    expect(h.lastAlpha).toBeGreaterThanOrEqual(0);
    expect(h.lastAlpha).toBeLessThan(1);
  });

  it('clamps catch-up ticks on a huge stall (no spiral of death)', () => {
    const h = makeLoop();
    const res = h.loop.runFrame(100); // huge stall: bounded by maxFrameSeconds clamp + maxCatchUpTicks
    // 0.25s clamp / (1/30s) = 7.5 -> 7 whole ticks, and never above the 8-tick catch-up cap.
    expect(res.ticks).toBeGreaterThan(0);
    expect(res.ticks).toBeLessThanOrEqual(8);
    expect(res.ticks).toBe(7);
  });

  it('renders even when zero ticks elapsed (render decoupled from sim rate)', () => {
    const h = makeLoop();
    const res = h.loop.runFrame(0.001);
    expect(res.ticks).toBe(0);
    expect(h.renders).toBe(1);
  });
});
