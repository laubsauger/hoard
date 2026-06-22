// T35 — thin INPUT contracts for the §I debug data this lane consumes.
// These are OWNED BY LANE X. Other lanes feed plain numbers/records into these shapes; lane X never
// imports render/sim/nav internals. This keeps diagnostics decoupled (parallelization protocol: a lane
// reads other lanes only through narrow contracts, never their guts).

/** Per-frame timing fed by the render/engine frame loop (§I frame timing). */
export interface FrameTimingInput {
  /** Wall-clock duration of the last full frame. */
  readonly frameMs: number;
  /** Main-thread cost share of the last frame. */
  readonly mainThreadMs: number;
  /** GPU cost estimate of the last frame. */
  readonly gpuMs: number;
}

/** Depth of one named worker's pending message queue (§I worker queue depth). */
export interface WorkerQueueInput {
  readonly name: string;
  readonly depth: number;
}

/** Authoritative simulation timing fed by the fixed-tick scheduler (§I sim timing). */
export interface SimTimingInput {
  /** Cost of the last authoritative tick. */
  readonly tickMs: number;
  /** Effective authoritative ticks per second. */
  readonly ticksPerSecond: number;
  /** Number of scheduler frequency buckets that executed on the last tick. */
  readonly bucketsRun: number;
}

/** A discrete GC or save event marker (§I GC + save ops). */
export interface DiagnosticMarker {
  readonly kind: 'gc' | 'save';
  /** Timestamp (ms, monotonic source) the marker occurred. */
  readonly atMs: number;
  /** Duration of the event, if measured. */
  readonly durationMs: number;
}

/** Render statistics (§I draw calls/triangles/instances/anim-groups/lights/shadows/GPU-mem/textures). */
export interface RenderStatsInput {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly instances: number;
  readonly animGroups: number;
  readonly lights: number;
  readonly shadowCasters: number;
  /** Estimated resident GPU memory. */
  readonly gpuMemBytesEstimate: number;
  /** Number of resident textures. */
  readonly textureResidentCount: number;
  /** Estimated bytes of resident texture memory. */
  readonly textureResidentBytes: number;
}

/** Zombie population breakdown (§I zombie tier/render-tier/state/target/update-freq). */
export interface ZombiePopulationInput {
  /** Count of zombies per simulation tier, index = tier (0 hero .. 3 abstract). */
  readonly simTierCounts: readonly number[];
  /** Count of zombies per render tier, index = render tier. */
  readonly renderTierCounts: readonly number[];
  /** Count of zombies per behaviour state, keyed by state name. */
  readonly stateCounts: Readonly<Record<string, number>>;
  /** Count of zombies per scheduler update-frequency bucket, keyed by bucket name. */
  readonly updateFreqCounts: Readonly<Record<string, number>>;
  /** Number of zombies currently holding a target/stimulus ref. */
  readonly withTarget: number;
}

/** Collision broad-phase occupancy (§I spatial-hash occupancy + collision candidate counts). */
export interface SpatialHashInput {
  /** Non-empty spatial-hash cells. */
  readonly occupiedCells: number;
  /** Total candidate pairs surfaced by the broad phase this frame. */
  readonly candidatePairs: number;
  /** Deepest single-cell bucket occupancy. */
  readonly maxBucketDepth: number;
}

/** Structural-module state (§I structural occupancy cells + support links + dirty regions). */
export interface StructuralInput {
  readonly occupiedCells: number;
  readonly supportLinks: number;
  readonly dirtyRegions: number;
}

/** Navigation field state (§I flow-field vectors + portals + blocked links + dirty nav tiles). */
export interface NavFieldInput {
  /** Active cached flow fields. */
  readonly flowFields: number;
  readonly portals: number;
  readonly blockedLinks: number;
  readonly dirtyNavTiles: number;
}

/** Live tracked-resource counts (§I texture residency / V24 leak counters), per ResourceRegistry kind. */
export interface ResourceCountsInput {
  readonly geometry: number;
  readonly texture: number;
  readonly material: number;
  readonly renderTarget: number;
  readonly buffer: number;
  readonly effect: number;
  readonly other: number;
}
