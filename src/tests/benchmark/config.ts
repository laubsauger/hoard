// T36 — benchmark suite configuration (lane X, tests-only).
// V4: every horde count / tick count / spawn extent / tolerance is a documented, typed constant here —
// NO magic numbers scattered through the scene or harness code. V10: counts are GATES recorded against
// the conditions they were run under (tier + tick rate + active systems), never marketing claims.
//
// These values size the SIX §V benchmark scenes. They stay well under the SoA capacity gate
// (zombies.capacity = 5000 desktop-high / 1500 mobile-webgpu) so spawning never exhausts the store.

import type { QualityTier } from '@/config/types';

/** Units carried in names per V26: cells = nav grid cells, m = world metres, ticks = fixed sim ticks. */
export interface BenchSceneConfig {
  /** Human-readable scene id, mirrored into the BenchmarkResult and the stored baseline. */
  readonly name: string;
  /** Quality tier the scene runs at (drives tickHz, flow-field cache size, mobile counts — V25). */
  readonly tier: QualityTier;
  /** Fixed sim ticks recorded into the percentile window (the measured sample count). */
  readonly ticks: number;
  /** Leading ticks run but excluded from stats so caches/JIT warm before sampling. */
  readonly warmupTicks: number;
  /** Zombies spawned into the scene (the headline count this scene's gate records). */
  readonly hordeCount: number;
  /** Acceptable post-run live-entity window (gunfire/attrition may trim a few — V10 records actuals). */
  readonly minLiveEntities: number;
  readonly maxLiveEntities: number;
}

/**
 * Regression tolerance. CI hardware varies wildly, so the ceiling is GENEROUS and combines two terms:
 *   ceiling = max(baseline_ms * toleranceFactor, absoluteFloorMs)
 * The multiplicative term catches large regressions relative to the recorded baseline; the additive
 * floor stops a tiny (sub-millisecond) baseline on a fast dev box from producing an unattainably small
 * ceiling on a slow CI runner. Both terms are documented constants (V4).
 */
export const BENCHMARK_TOLERANCE = {
  /** Multiplier applied to each recorded baseline percentile before asserting (≥1; large = lenient). */
  toleranceFactor: 8,
  /** Absolute floor ceilings (ms) so noise on a fast baseline never trips the assert. */
  floorMs: {
    median: 4,
    p95: 12,
    p99: 24,
  },
} as const;

/** Fixed tier counts pulled from the zombies config caps so the suite never exceeds the SoA store. */
const DESKTOP_TIER: QualityTier = 'desktop-high';
const MOBILE_TIER: QualityTier = 'mobile-webgpu';

/**
 * The six §V benchmark scenes. Counts are intentionally conservative versus the §V-gates "2,000
 * individually addressable low-tier (stretch beyond)" target: this is a CPU-sim proxy in Node, not the
 * in-browser GPU capture, so we record an honest sustainable CPU sample rather than the visual stretch.
 */
export const BENCHMARK_SCENES = {
  /** Crowd avenue: long open street, thousands of zombies on one shared flow field, periodic gunfire. */
  crowdAvenue: {
    name: 'crowd-avenue',
    tier: DESKTOP_TIER,
    ticks: 160,
    warmupTicks: 15,
    hordeCount: 2000,
    minLiveEntities: 1900,
    maxLiveEntities: 2000,
  },
  /** Breach cascade: a horde sealed behind a multi-section wall that is breached cell-by-cell while nav
   *  dirties and the shared flow field is repeatedly invalidated. */
  breachCascade: {
    name: 'breach-cascade',
    tier: DESKTOP_TIER,
    ticks: 150,
    warmupTicks: 10,
    hordeCount: 1500,
    minLiveEntities: 1500,
    maxLiveEntities: 1500,
  },
  /** Dense interior: multi-room partitioned building, close combat (frequent gunfire) near the player. */
  denseInterior: {
    name: 'dense-interior',
    tier: DESKTOP_TIER,
    ticks: 150,
    warmupTicks: 10,
    hordeCount: 800,
    minLiveEntities: 720,
    maxLiveEntities: 800,
  },
  /** Streaming sprint: player traverses the whole grid (crossing sector/tile boundaries) while a horde
   *  in the adjacent area tracks it — the moving target forces repeated flow-field recomputes. */
  streamingSprint: {
    name: 'streaming-sprint',
    tier: DESKTOP_TIER,
    ticks: 180,
    warmupTicks: 15,
    hordeCount: 1200,
    minLiveEntities: 1200,
    maxLiveEntities: 1200,
  },
  /** Corpse accumulation: thousands of settled bodies in the loaded set with repeated save → evict →
   *  reload cycles (the persistence serialize/restore path is the headline cost here). */
  corpseAccumulation: {
    name: 'corpse-accumulation',
    tier: DESKTOP_TIER,
    ticks: 140,
    warmupTicks: 10,
    hordeCount: 3000,
    minLiveEntities: 3000,
    maxLiveEntities: 3000,
    /** Save/reload every N timed ticks (untimed maintenance; cost surfaced separately). */
    saveReloadEveryTicks: 45,
  },
  /** Mobile capability: reduced-tier counts + 20 Hz tick + smaller flow cache (V25 capability scaling). */
  mobileCapability: {
    name: 'mobile-capability',
    tier: MOBILE_TIER,
    ticks: 140,
    warmupTicks: 10,
    hordeCount: 1200,
    minLiveEntities: 1140,
    maxLiveEntities: 1200,
  },
} as const;

export type BenchmarkSceneKey = keyof typeof BENCHMARK_SCENES;

/** How often (timed ticks) gunfire is emitted into a scene that exercises the combat path. */
export const GUNFIRE_CADENCE = {
  /** Crowd avenue: sparse suppressing fire so attrition stays negligible against thousands. */
  crowdAvenueEveryTicks: 15,
  /** Dense interior: heavier close-quarters fire. */
  denseInteriorEveryTicks: 6,
} as const;

/** How often (timed ticks) the breach-cascade scene drives the next wall-section breach. */
export const BREACH_CADENCE_TICKS = 8;
