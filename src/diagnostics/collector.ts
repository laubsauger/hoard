// T35 / V27 — diagnostics collector. Aggregates the §I debug inputs into a single plain snapshot
// the overlay can read. Holds the frame-time percentile ring + a bounded marker history. All sections
// are nullable: a section reads null until its lane has fed data (honest "no data", not a fake zero).

import { PercentileRing, type FrameTimeSummary } from './percentile';
import type {
  FrameTimingInput,
  WorkerQueueInput,
  SimTimingInput,
  DiagnosticMarker,
  RenderStatsInput,
  ZombiePopulationInput,
  SpatialHashInput,
  StructuralInput,
  NavFieldInput,
  ResourceCountsInput,
} from './inputs';

/** Immutable aggregate read by the overlay. Plain data — no live world arrays (V1). */
export interface DiagnosticsSnapshot {
  /** Percentile summary over the frame-time window, or null before any frame is recorded. */
  readonly frameTime: FrameTimeSummary | null;
  readonly lastFrameMs: number;
  readonly mainThreadMs: number;
  readonly gpuMs: number;
  readonly workerQueues: readonly WorkerQueueInput[];
  readonly sim: SimTimingInput | null;
  /** Recent GC/save markers, oldest first, bounded by config markerHistorySize. */
  readonly markers: readonly DiagnosticMarker[];
  readonly render: RenderStatsInput | null;
  readonly zombies: ZombiePopulationInput | null;
  readonly spatialHash: SpatialHashInput | null;
  readonly structural: StructuralInput | null;
  readonly navField: NavFieldInput | null;
  readonly resources: ResourceCountsInput | null;
}

export const EMPTY_SNAPSHOT: DiagnosticsSnapshot = {
  frameTime: null,
  lastFrameMs: 0,
  mainThreadMs: 0,
  gpuMs: 0,
  workerQueues: [],
  sim: null,
  markers: [],
  render: null,
  zombies: null,
  spatialHash: null,
  structural: null,
  navField: null,
  resources: null,
};

export class DiagnosticsCollector {
  private readonly frameRing: PercentileRing;
  private readonly markerHistorySize: number;

  private lastFrameMs = 0;
  private mainThreadMs = 0;
  private gpuMs = 0;
  private workerQueues: readonly WorkerQueueInput[] = [];
  private sim: SimTimingInput | null = null;
  private markers: DiagnosticMarker[] = [];
  private render: RenderStatsInput | null = null;
  private zombies: ZombiePopulationInput | null = null;
  private spatialHash: SpatialHashInput | null = null;
  private structural: StructuralInput | null = null;
  private navField: NavFieldInput | null = null;
  private resources: ResourceCountsInput | null = null;

  constructor(percentileWindowSize: number, markerHistorySize: number) {
    if (!Number.isInteger(markerHistorySize) || markerHistorySize < 1) {
      throw new Error(`markerHistorySize must be a positive integer, got ${markerHistorySize}`);
    }
    this.frameRing = new PercentileRing(percentileWindowSize);
    this.markerHistorySize = markerHistorySize;
  }

  recordFrame(input: FrameTimingInput): void {
    this.frameRing.push(input.frameMs);
    this.lastFrameMs = input.frameMs;
    this.mainThreadMs = input.mainThreadMs;
    this.gpuMs = input.gpuMs;
  }

  setWorkerQueues(queues: readonly WorkerQueueInput[]): void {
    this.workerQueues = queues.map((q) => ({ name: q.name, depth: q.depth }));
  }

  setSim(sim: SimTimingInput): void {
    this.sim = sim;
  }

  /** Append a GC/save marker, evicting the oldest beyond the bounded history (no unbounded growth). */
  pushMarker(marker: DiagnosticMarker): void {
    this.markers.push(marker);
    if (this.markers.length > this.markerHistorySize) {
      this.markers.splice(0, this.markers.length - this.markerHistorySize);
    }
  }

  setRender(render: RenderStatsInput): void {
    this.render = render;
  }

  setZombies(zombies: ZombiePopulationInput): void {
    this.zombies = zombies;
  }

  setSpatialHash(spatialHash: SpatialHashInput): void {
    this.spatialHash = spatialHash;
  }

  setStructural(structural: StructuralInput): void {
    this.structural = structural;
  }

  setNavField(navField: NavFieldInput): void {
    this.navField = navField;
  }

  setResources(resources: ResourceCountsInput): void {
    this.resources = resources;
  }

  /** Number of frame samples currently in the percentile window. */
  get frameSampleCount(): number {
    return this.frameRing.size;
  }

  /** Produce an immutable aggregate. Cheap; safe to call on the throttled refresh cadence. */
  snapshot(): DiagnosticsSnapshot {
    return {
      frameTime: this.frameRing.summary(),
      lastFrameMs: this.lastFrameMs,
      mainThreadMs: this.mainThreadMs,
      gpuMs: this.gpuMs,
      workerQueues: this.workerQueues,
      sim: this.sim,
      markers: [...this.markers],
      render: this.render,
      zombies: this.zombies,
      spatialHash: this.spatialHash,
      structural: this.structural,
      navField: this.navField,
      resources: this.resources,
    };
  }
}
