// T36 — benchmark regression test (lane X). Runs all six §V benchmark scenes through the perf-capture
// harness ONCE, then asserts each: completed with zero errors, held its expected entity-count window, and
// stayed within a GENEROUS regression ceiling derived from the stored baseline (V10).
//
// Ceiling = max(baseline_ms * toleranceFactor, floorMs) — see config.ts. CI hardware varies, so this is a
// coarse "did something blow up 8x" guard, not a tight perf bound. The numbers are a CPU-sim PROXY
// captured in Node; GPU frame-time capture (browser/CDP) is DEFERRED (result.gpu stays null).
//
// Regenerate baselines:  BENCH_RECORD=1 npx vitest run src/tests/benchmark

import { describe, it, expect, beforeAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allBenchmarkScenes } from './scenes';
import { captureScene, type BenchmarkResult } from './harness';
import { BENCHMARK_SCENES, BENCHMARK_TOLERANCE } from './config';
import baselines from './baselines.json';

/** Fixed capture timestamp — committed test logic must NOT call Date.now (V4); inject a constant. */
const BENCH_CAPTURE_TIMESTAMP = 1_750_000_000_000;
/** Generous wall-clock budget for running all six scenes once. */
const CAPTURE_TIMEOUT_MS = 180_000;

interface BaselineEntry {
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly entityCount: number;
}
type BaselineFile = {
  method: string;
  note: string;
  scenes: Record<string, BaselineEntry>;
};

const baseline = baselines as BaselineFile;
const RECORD = process.env.BENCH_RECORD === '1';

function ceiling(metric: 'median' | 'p95' | 'p99', name: string): number {
  const floor = BENCHMARK_TOLERANCE.floorMs[metric];
  const entry = baseline.scenes[name];
  if (!entry) return floor; // no baseline yet → assert only against the absolute floor.
  const ref = metric === 'median' ? entry.medianMs : metric === 'p95' ? entry.p95Ms : entry.p99Ms;
  return Math.max(ref * BENCHMARK_TOLERANCE.toleranceFactor, floor);
}

const results = new Map<string, BenchmarkResult>();

describe('T36 — §V benchmark suite (CPU-sim proxy)', () => {
  beforeAll(async () => {
    for (const scene of allBenchmarkScenes()) {
      results.set(scene.name, await captureScene(scene, { timestamp: BENCH_CAPTURE_TIMESTAMP }));
    }

    // First perf snapshot — printed every run so a reader sees the actual numbers (V10 transparency).
    const rows = [...results.values()].map((r) => ({
      scene: r.scene,
      tier: r.tier,
      entities: r.entityCount,
      ticks: r.ticks,
      median_ms: +r.cpu.medianMs.toFixed(4),
      p95_ms: +r.cpu.p95Ms.toFixed(4),
      p99_ms: +r.cpu.p99Ms.toFixed(4),
      max_ms: +r.cpu.maxMs.toFixed(4),
      extra: r.extra,
    }));
    console.table(rows);

    if (RECORD) {
      const scenes: Record<string, BaselineEntry> = {};
      for (const r of results.values()) {
        scenes[r.scene] = {
          medianMs: +r.cpu.medianMs.toFixed(4),
          p95Ms: +r.cpu.p95Ms.toFixed(4),
          p99Ms: +r.cpu.p99Ms.toFixed(4),
          entityCount: r.entityCount,
        };
      }
      const out: BaselineFile = { method: baseline.method, note: baseline.note, scenes };
      const path = fileURLToPath(new URL('./baselines.json', import.meta.url));
      writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
      console.log(`[BENCH_RECORD] wrote baselines for ${Object.keys(scenes).length} scenes to ${path}`);
    }
  }, CAPTURE_TIMEOUT_MS);

  it('captures all six benchmark scenes', () => {
    expect(results.size).toBe(6);
    for (const r of results.values()) expect(r.method).toBe('node-cpu-proxy');
  });

  for (const cfg of Object.values(BENCHMARK_SCENES)) {
    describe(cfg.name, () => {
      it('completes with no errors and a populated percentile window', () => {
        const r = results.get(cfg.name)!;
        expect(r).toBeDefined();
        expect(r.errors).toBe(0);
        expect(r.cpu.sampleCount).toBe(cfg.ticks);
        expect(Number.isFinite(r.cpu.medianMs)).toBe(true);
        expect(r.cpu.medianMs).toBeGreaterThanOrEqual(0);
      });

      it('holds its expected entity-count window (V10 records actuals)', () => {
        const r = results.get(cfg.name)!;
        expect(r.entityCount).toBeGreaterThanOrEqual(cfg.minLiveEntities);
        expect(r.entityCount).toBeLessThanOrEqual(cfg.maxLiveEntities);
      });

      it('stays within the generous regression ceiling', () => {
        const r = results.get(cfg.name)!;
        expect(r.cpu.medianMs).toBeLessThanOrEqual(ceiling('median', cfg.name));
        expect(r.cpu.p95Ms).toBeLessThanOrEqual(ceiling('p95', cfg.name));
        expect(r.cpu.p99Ms).toBeLessThanOrEqual(ceiling('p99', cfg.name));
      });

      it('defers GPU frame-time capture (browser/CDP concern)', () => {
        const r = results.get(cfg.name)!;
        expect(r.gpu).toBeNull();
      });
    });
  }
});
