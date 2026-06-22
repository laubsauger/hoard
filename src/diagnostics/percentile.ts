// T35 / §V profiling — ring-buffer percentile tracker for frame times.
// Records the most recent `capacity` samples and reports median / 95th / 99th via nearest-rank.
// Node-testable, no GPU/DOM. No fabricated data: querying an empty window throws; callers use
// summary() which returns null until there is at least one sample (honest "no data yet").

export interface FrameTimeSummary {
  /** Number of samples currently in the window. */
  readonly sampleCount: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  /** Smallest sample in the window (best frame). */
  readonly minMs: number;
  /** Largest sample in the window (worst frame). */
  readonly maxMs: number;
}

export class PercentileRing {
  private readonly buf: Float64Array;
  private count = 0;
  private next = 0;

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`PercentileRing capacity must be a positive integer, got ${capacity}`);
    }
    this.buf = new Float64Array(capacity);
  }

  /** Number of samples currently retained (<= capacity). */
  get size(): number {
    return this.count;
  }

  /** Record one sample, overwriting the oldest once the window is full. */
  push(value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`PercentileRing sample must be a finite number, got ${value}`);
    }
    this.buf[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
  }

  clear(): void {
    this.count = 0;
    this.next = 0;
  }

  /** Sorted copy of the live window (ascending). Empty when no samples. */
  private sorted(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.count; i += 1) out.push(this.buf[i]!);
    out.sort((a, b) => a - b);
    return out;
  }

  /**
   * Nearest-rank percentile, p in [0,1]. p=0.5 -> median, p=0.95 -> 95th.
   * rank = ceil(p * n), clamped to [1, n]; returns the value at that 1-based rank.
   * Throws on an empty window (no invented value).
   */
  percentile(p: number): number {
    if (p < 0 || p > 1 || !Number.isFinite(p)) {
      throw new Error(`percentile p must be within [0,1], got ${p}`);
    }
    if (this.count === 0) {
      throw new Error('percentile() called on an empty window');
    }
    const sorted = this.sorted();
    const n = sorted.length;
    const rank = Math.max(1, Math.min(n, Math.ceil(p * n)));
    return sorted[rank - 1]!;
  }

  /** Aggregate summary, or null when the window holds no samples. */
  summary(): FrameTimeSummary | null {
    if (this.count === 0) return null;
    const sorted = this.sorted();
    const n = sorted.length;
    const at = (p: number): number => sorted[Math.max(1, Math.min(n, Math.ceil(p * n))) - 1]!;
    return {
      sampleCount: n,
      medianMs: at(0.5),
      p95Ms: at(0.95),
      p99Ms: at(0.99),
      minMs: sorted[0]!,
      maxMs: sorted[n - 1]!,
    };
  }
}
