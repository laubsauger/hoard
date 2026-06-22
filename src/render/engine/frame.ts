// T5 / V12 — frame orchestration. Authoritative sim runs FIXED ticks independent of render rate;
// render interpolates between stable snapshots using alpha. This module is GPU-free and node-testable:
// it drives a FixedClock + injected sim/render callbacks and never constructs a renderer.

import { FixedClock } from '../../game/core';

/** Called once per authoritative fixed tick, in order. `tick` is the absolute tick index after stepping. */
export type SimUpdate = (tickIndex: number, tickSeconds: number) => void;

/** Called once per rendered frame with interpolation alpha in [0,1) between the last and next tick (V12). */
export type RenderFn = (alpha: number) => void;

export interface FrameResult {
  /** Number of fixed sim ticks integrated this frame (0..maxCatchUpTicks). */
  readonly ticks: number;
  /** Interpolation alpha used for the render this frame. */
  readonly alpha: number;
}

/** A monotonic time source in seconds, injectable for tests (default = performance.now/1000). */
export type TimeSource = () => number;

function defaultTimeSource(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now() / 1000;
  }
  return Date.now() / 1000;
}

/**
 * Drives one render frame: advance the clock by real elapsed time, run the sim the resulting number
 * of fixed ticks (preserving authoritative order, V12), then render once with the leftover alpha.
 */
export class FrameLoop {
  private readonly clock: FixedClock;
  private readonly simUpdate: SimUpdate;
  private readonly render: RenderFn;
  private readonly now: TimeSource;
  private lastTime: number | null = null;
  private running = false;

  constructor(opts: {
    clock: FixedClock;
    simUpdate: SimUpdate;
    render: RenderFn;
    now?: TimeSource;
  }) {
    this.clock = opts.clock;
    this.simUpdate = opts.simUpdate;
    this.render = opts.render;
    this.now = opts.now ?? defaultTimeSource;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Run a single frame given an explicit real delta (seconds). Returns tick count + alpha.
   * Deterministic + node-testable — callers in tests use this directly instead of an raf loop.
   */
  runFrame(realDeltaSeconds: number): FrameResult {
    const ticks = this.clock.advance(realDeltaSeconds);
    for (let i = 0; i < ticks; i++) {
      // tick has already been incremented inside advance(); reconstruct the in-order index per step.
      const tickIndex = this.clock.tick - (ticks - 1 - i);
      this.simUpdate(tickIndex, this.clock.tickSeconds);
    }
    const alpha = this.clock.alpha;
    this.render(alpha);
    return { ticks, alpha };
  }

  /** Advance using wall-clock delta since the previous tick() call (drives the live raf loop). */
  tickFromClock(): FrameResult {
    const t = this.now();
    const dt = this.lastTime === null ? 0 : t - this.lastTime;
    this.lastTime = t;
    return this.runFrame(dt);
  }

  /**
   * Start a render loop using an injected scheduler (default requestAnimationFrame).
   * The scheduler MUST be provided in non-DOM environments; we do not silently fake one (V4).
   */
  start(schedule: (cb: () => void) => number = requestAnimationFrame, cancel: (h: number) => void = cancelAnimationFrame): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = null;
    let handle = 0;
    const frame = (): void => {
      if (!this.running) {
        cancel(handle);
        return;
      }
      this.tickFromClock();
      handle = schedule(frame);
    };
    handle = schedule(frame);
  }

  stop(): void {
    this.running = false;
    this.lastTime = null;
  }
}
