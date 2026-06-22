// T3 / V12 — fixed-tick clock. Authoritative sim advances in fixed steps independent of render rate.
// Render interpolates between ticks using `alpha`. Accumulator is clamped to avoid spiral-of-death.

export interface ClockConfig {
  /** Fixed ticks per second. */
  readonly tickHz: number;
  /** Clamp on accumulated real time per frame (seconds). */
  readonly maxFrameSeconds: number;
  /** Max fixed ticks integrated in one frame; surplus accumulated time is dropped. */
  readonly maxCatchUpTicks: number;
}

export class FixedClock {
  readonly tickSeconds: number;
  private readonly maxFrameSeconds: number;
  private readonly maxCatchUpTicks: number;
  private accumulator = 0;
  private _tick = 0;

  constructor(config: ClockConfig) {
    if (config.tickHz <= 0) throw new Error(`tickHz must be > 0, got ${config.tickHz}`);
    this.tickSeconds = 1 / config.tickHz;
    this.maxFrameSeconds = config.maxFrameSeconds;
    this.maxCatchUpTicks = config.maxCatchUpTicks;
  }

  /** Current authoritative tick index. */
  get tick(): number {
    return this._tick;
  }

  /** Interpolation factor 0..1 between the last and next tick, for render (V12). */
  get alpha(): number {
    return this.accumulator / this.tickSeconds;
  }

  /**
   * Feed real elapsed seconds; returns how many fixed ticks to run this frame.
   * Caller runs the sim update exactly that many times. Surplus time beyond the
   * catch-up cap is discarded so a stalled frame cannot trigger an unbounded loop.
   */
  advance(realDeltaSeconds: number): number {
    if (realDeltaSeconds < 0 || Number.isNaN(realDeltaSeconds)) {
      throw new Error(`realDeltaSeconds must be a non-negative number, got ${realDeltaSeconds}`);
    }
    this.accumulator += Math.min(realDeltaSeconds, this.maxFrameSeconds);
    let ticks = 0;
    while (this.accumulator >= this.tickSeconds && ticks < this.maxCatchUpTicks) {
      this.accumulator -= this.tickSeconds;
      this._tick += 1;
      ticks += 1;
    }
    // Drop surplus that would exceed the catch-up cap (keep sub-tick remainder for alpha).
    if (this.accumulator >= this.tickSeconds) {
      this.accumulator = this.accumulator % this.tickSeconds;
    }
    return ticks;
  }
}
