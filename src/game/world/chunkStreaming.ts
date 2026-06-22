// T14 / V24 — chunk streaming lifecycle state machine.
// A render chunk progresses through explicit states with a CLOSED set of valid transitions; an
// illegal transition throws (V4 — no silent state corruption). Each chunk owns disposable resources
// (geometry/textures/materials/buffers) registered as it warms up; on eviction every resource's
// disposal hook runs (V24 — no leaks). Cooling absorbs camera jitter before persist+evict.

import { resolveDomain } from '@/config/registry';
import { streamingConfig } from '@/config/domains/streaming';
import type { QualityTier, ResolvedDomain } from '@/config/types';

/** Lifecycle states, in warm-up order. */
export type ChunkState =
  | 'unloaded'
  | 'abstract'
  | 'meta'
  | 'cpu-load'
  | 'sim-active'
  | 'visual'
  | 'high-detail'
  | 'cooling'
  | 'persisted-evicted';

export const CHUNK_STATES: readonly ChunkState[] = [
  'unloaded', 'abstract', 'meta', 'cpu-load', 'sim-active', 'visual', 'high-detail', 'cooling', 'persisted-evicted',
];

/** Closed transition table. Warm-up is monotonic; any active state can drop to cooling; cooling
 *  either re-warms (camera returned) or persists+evicts; an evicted chunk returns to unloaded. */
const TRANSITIONS: Record<ChunkState, readonly ChunkState[]> = {
  unloaded: ['abstract'],
  abstract: ['meta', 'unloaded'],
  meta: ['cpu-load', 'abstract'],
  'cpu-load': ['sim-active', 'cooling'],
  'sim-active': ['visual', 'cooling'],
  visual: ['high-detail', 'cooling'],
  'high-detail': ['cooling'],
  cooling: ['sim-active', 'persisted-evicted'],
  'persisted-evicted': ['unloaded'],
};

export function isValidTransition(from: ChunkState, to: ChunkState): boolean {
  return TRANSITIONS[from].includes(to);
}

export type DisposeFn = () => void;

interface ChunkRecord {
  state: ChunkState;
  /** resourceId -> disposal hook (V24). */
  readonly resources: Map<string, DisposeFn>;
  /** Tick the chunk entered cooling (for the coolingTicks dwell). */
  coolingSince: number | null;
}

export type StreamingSettings = ResolvedDomain<typeof streamingConfig>;

const REFERENCE_TIER: QualityTier = 'desktop-high';

export class ChunkStreamer {
  readonly settings: StreamingSettings;
  private readonly chunks = new Map<number, ChunkRecord>();

  constructor(tier: QualityTier = REFERENCE_TIER) {
    this.settings = resolveDomain(streamingConfig, tier);
  }

  /** Register a chunk at the initial unloaded state. */
  track(chunk: number): void {
    if (this.chunks.has(chunk)) throw new Error(`chunk ${chunk} already tracked`);
    this.chunks.set(chunk, { state: 'unloaded', resources: new Map(), coolingSince: null });
  }

  stateOf(chunk: number): ChunkState {
    return this.record(chunk).state;
  }

  /** Attach a disposable resource to a chunk (V24 — explicit ownership + disposal). */
  registerResource(chunk: number, resourceId: string, dispose: DisposeFn): void {
    const rec = this.record(chunk);
    if (rec.resources.has(resourceId)) throw new Error(`resource '${resourceId}' already registered on chunk ${chunk}`);
    rec.resources.set(resourceId, dispose);
  }

  resourceCount(chunk: number): number {
    return this.record(chunk).resources.size;
  }

  /**
   * Transition a chunk. Throws on an illegal transition. Entering persisted-evicted runs every
   * registered disposal hook and clears the registry (V24). `tick` stamps cooling entry.
   */
  transition(chunk: number, to: ChunkState, tick = 0): void {
    const rec = this.record(chunk);
    if (!isValidTransition(rec.state, to)) {
      throw new Error(`illegal chunk transition ${rec.state} -> ${to} (chunk ${chunk})`);
    }
    rec.state = to;
    if (to === 'cooling') rec.coolingSince = tick;
    else rec.coolingSince = null;
    if (to === 'persisted-evicted') this.disposeResources(rec);
  }

  /** True once a cooling chunk has dwelt past coolingTicks and may be persisted+evicted. */
  readyToEvict(chunk: number, currentTick: number): boolean {
    const rec = this.record(chunk);
    if (rec.state !== 'cooling' || rec.coolingSince === null) return false;
    return currentTick - rec.coolingSince >= this.settings.coolingTicks;
  }

  /** Count of chunks currently in a given state (capacity diagnostics — streaming budgets). */
  countInState(state: ChunkState): number {
    let n = 0;
    for (const rec of this.chunks.values()) if (rec.state === state) n += 1;
    return n;
  }

  private disposeResources(rec: ChunkRecord): void {
    for (const dispose of rec.resources.values()) dispose();
    rec.resources.clear();
  }

  private record(chunk: number): ChunkRecord {
    const rec = this.chunks.get(chunk);
    if (!rec) throw new Error(`chunk ${chunk} not tracked`);
    return rec;
  }
}
