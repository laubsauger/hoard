// T36 — reusable perf-capture harness (lane X, tests-only). Runs a scene's authoritative sim `update`
// for a fixed number of ticks, brackets each tick with a monotonic clock, and summarises the per-tick
// CPU cost (median / p95 / p99) by REUSING the diagnostics PercentileRing — the same nearest-rank
// summariser the in-game profiler uses, so the offline benchmark and the live overlay agree.
//
// Scope (V10): this measures CPU SIM cost only. GPU frame-time capture is a browser/CDP concern and is
// DEFERRED — the result carries an optional GPU slot and the harness accepts a pluggable GpuTimingSource
// so a WebGPU timestamp-query / CDP source can be wired in later without reshaping anything.

import { PercentileRing } from '@/diagnostics/percentile';
import type { QualityTier } from '@/config/types';

/**
 * One driveable benchmark scene instance. `setup()` builds fresh authoritative state and returns this;
 * the harness then times `step()` once per tick. Any synchronous per-tick stimulus (gunfire, breaching,
 * player movement) happens INSIDE `step` so its CPU cost is part of the measured tick. Asynchronous
 * maintenance that must not pollute the per-tick sample (save → evict → reload) goes in `maintain`.
 */
export interface SceneRun {
  /** Advance exactly one fixed tick. The TIMED region. Throw to signal an error (counted, not hidden). */
  step(tickIndex: number): void;
  /** Untimed async work after a recorded tick (e.g. persistence cycles). Optional. */
  maintain?(tickIndex: number): Promise<void>;
  /** Current live entity count (reported + asserted against the scene's expected window). */
  entityCount(): number;
  /** Extra measured costs (ms) to attach to the result, e.g. { saveReloadMs }. Optional. */
  extra?(): Readonly<Record<string, number>>;
}

export interface BenchmarkScene {
  readonly name: string;
  readonly tier: QualityTier;
  readonly ticks: number;
  readonly warmupTicks: number;
  setup(): SceneRun;
}

/**
 * Pluggable GPU timing source (DEFERRED). A browser harness backs this with a WebGPU timestamp query or
 * a CDP `Tracing`/`Performance` sample; in Node it is absent and the GPU slot stays null (honest "no
 * data" rather than a fabricated zero — same discipline as PercentileRing.summary()).
 */
export interface GpuTimingSource {
  /** GPU time (ms) attributable to the most recent tick, or null when unavailable. */
  sampleTickMs(): number | null;
}

export interface PercentileSummaryMs {
  readonly sampleCount: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
}

export interface BenchmarkResult {
  readonly scene: string;
  readonly tier: QualityTier;
  /** Recorded (timed) ticks. */
  readonly ticks: number;
  /** Warmup ticks run but excluded from the percentile window. */
  readonly warmupTicks: number;
  readonly entityCount: number;
  /** Per-tick CPU sim cost summary. */
  readonly cpu: PercentileSummaryMs;
  /** Per-tick GPU summary, or null — capture deferred (see GpuTimingSource). */
  readonly gpu: PercentileSummaryMs | null;
  /** Steps that threw during the run (must be 0 for a healthy capture). */
  readonly errors: number;
  /** Scene-specific extra costs in ms (e.g. saveReloadMs). */
  readonly extra: Readonly<Record<string, number>>;
  /** Provenance: this is a hardware-agnostic CPU proxy, not the in-browser GPU capture. */
  readonly method: 'node-cpu-proxy';
  /** Caller-supplied capture timestamp (epoch ms). NOT read from Date.now inside committed logic (V4). */
  readonly timestamp: number;
}

export interface CaptureOptions {
  /** Capture timestamp (epoch ms). Injected so committed test logic never calls Date.now. */
  readonly timestamp: number;
  /** Monotonic clock; defaults to performance.now (Node global). Injectable for deterministic tests. */
  readonly now?: () => number;
  /** Optional GPU timing source (deferred; null result when absent). */
  readonly gpu?: GpuTimingSource;
}

function summarise(ring: PercentileRing): PercentileSummaryMs {
  const s = ring.summary();
  if (!s) throw new Error('benchmark produced no samples — ticks must be >= 1');
  return {
    sampleCount: s.sampleCount,
    medianMs: s.medianMs,
    p95Ms: s.p95Ms,
    p99Ms: s.p99Ms,
    minMs: s.minMs,
    maxMs: s.maxMs,
  };
}

/**
 * Run a scene and produce a structured BenchmarkResult. Warmup ticks run (and maintain) before sampling
 * so cache/JIT effects do not skew the window; the timed window then records per-tick CPU (and optional
 * GPU) cost into PercentileRings sized to the tick count.
 */
export async function captureScene(scene: BenchmarkScene, opts: CaptureOptions): Promise<BenchmarkResult> {
  const now = opts.now ?? (() => performance.now());
  const run = scene.setup();
  const cpuRing = new PercentileRing(scene.ticks);
  const gpuRing = opts.gpu ? new PercentileRing(scene.ticks) : null;
  let errors = 0;
  let gpuSamples = 0;

  // Warmup: run and maintain, but record nothing.
  for (let i = 0; i < scene.warmupTicks; i++) {
    try {
      run.step(i);
    } catch {
      errors += 1;
    }
    if (run.maintain) await run.maintain(i);
  }

  // Timed window.
  for (let i = 0; i < scene.ticks; i++) {
    const tickIndex = scene.warmupTicks + i;
    const t0 = now();
    try {
      run.step(tickIndex);
    } catch {
      errors += 1;
    }
    const elapsed = now() - t0;
    cpuRing.push(elapsed >= 0 ? elapsed : 0);

    if (gpuRing && opts.gpu) {
      const g = opts.gpu.sampleTickMs();
      if (g !== null && Number.isFinite(g)) {
        gpuRing.push(g);
        gpuSamples += 1;
      }
    }
    if (run.maintain) await run.maintain(tickIndex);
  }

  return {
    scene: scene.name,
    tier: scene.tier,
    ticks: scene.ticks,
    warmupTicks: scene.warmupTicks,
    entityCount: run.entityCount(),
    cpu: summarise(cpuRing),
    gpu: gpuRing && gpuSamples > 0 ? summarise(gpuRing) : null,
    errors,
    extra: run.extra ? run.extra() : {},
    method: 'node-cpu-proxy',
    timestamp: opts.timestamp,
  };
}
