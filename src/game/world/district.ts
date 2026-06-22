// T40 — DISTRICT model (milestone-2). A representative district is a grid of streaming SECTORS. Each
// offscreen sector holds an ABSTRACT horde population (a count, not live entities — V13); when the player
// nears a sector it streams in through the chunk lifecycle (ChunkStreamer) and a capped slice of its
// abstract population is PROMOTED to live simulation. When the player leaves, the sector cools, persists,
// evicts, and its live members fold back to abstract (V13 — promotion/demotion conserves population).
//
// Streaming uses hysteresis (activate radius < evict radius) so the boundary does not thrash. This model
// owns ONLY counts + lifecycle; it emits a deterministic StreamingPlan the runtime applies to the live
// SoA. It never touches per-frame world state. All scales come from typed config (V4).

import { resolveDomain } from '@/config/registry';
import { worldConfig } from '@/config/domains/world';
import type { QualityTier } from '@/config/types';
import { ChunkStreamer, type ChunkState } from './chunkStreaming';

/** Authored placement of one sector within the district (world-space centre). */
export interface SectorDescriptor {
  readonly id: number;
  readonly centerX: number;
  readonly centerZ: number;
}

/** A capped promotion of abstract members to live sim near the player (V13). */
export interface SectorPromotion {
  readonly sectorId: number;
  readonly count: number;
  readonly centerX: number;
  readonly centerZ: number;
}

/** An eviction: the sector's live members fold back to abstract; the runtime despawns `count` of them. */
export interface SectorEviction {
  readonly sectorId: number;
  readonly count: number;
}

export interface StreamingPlan {
  readonly promotions: readonly SectorPromotion[];
  readonly evictions: readonly SectorEviction[];
}

/** Persisted per-sector population (V9 — compact: counts only, never live base entities). */
export interface SectorPopulationSave {
  readonly sectorId: number;
  readonly abstractPop: number;
  readonly liveCount: number;
}

interface SectorRuntime {
  readonly desc: SectorDescriptor;
  abstractPop: number;
  liveCount: number;
}

export interface DistrictSettings {
  readonly abstractPopulationPerSector: number;
  readonly activateRadiusMeters: number;
  readonly evictRadiusMeters: number;
  readonly promotedPerSectorCap: number;
}

export function resolveDistrictSettings(tier: QualityTier): DistrictSettings {
  const w = resolveDomain(worldConfig, tier);
  if (w.sectorEvictRadiusMeters <= w.sectorActivateRadiusMeters) {
    // Hysteresis invariant: evict radius MUST exceed activate radius or streaming thrashes (V4 — content error).
    throw new Error(
      `sectorEvictRadiusMeters (${w.sectorEvictRadiusMeters}) must exceed sectorActivateRadiusMeters (${w.sectorActivateRadiusMeters})`,
    );
  }
  return {
    abstractPopulationPerSector: w.abstractPopulationPerSector,
    activateRadiusMeters: w.sectorActivateRadiusMeters,
    evictRadiusMeters: w.sectorEvictRadiusMeters,
    promotedPerSectorCap: w.promotedPerSectorCap,
  };
}

/** Warm a chunk from `unloaded` up to `sim-active` through the closed lifecycle (ChunkStreamer validates). */
function warmToSimActive(streamer: ChunkStreamer, chunk: number): void {
  const path: ChunkState[] = ['abstract', 'meta', 'cpu-load', 'sim-active'];
  for (const s of path) streamer.transition(chunk, s);
}

export class DistrictModel {
  readonly settings: DistrictSettings;
  private readonly streamer: ChunkStreamer;
  private readonly sectors = new Map<number, SectorRuntime>();

  constructor(descriptors: readonly SectorDescriptor[], tier: QualityTier = 'desktop-high') {
    if (descriptors.length === 0) throw new Error('district requires at least one sector');
    this.settings = resolveDistrictSettings(tier);
    this.streamer = new ChunkStreamer(tier);
    for (const desc of descriptors) {
      if (this.sectors.has(desc.id)) throw new Error(`duplicate sector id ${desc.id}`);
      this.streamer.track(desc.id);
      // each sector owns one disposable streaming resource so eviction exercises the V24 disposal path.
      this.streamer.registerResource(desc.id, `sector.${desc.id}.batch`, () => {});
      this.sectors.set(desc.id, { desc, abstractPop: this.settings.abstractPopulationPerSector, liveCount: 0 });
    }
  }

  get sectorIds(): number[] {
    return [...this.sectors.keys()];
  }

  stateOf(sectorId: number): ChunkState {
    return this.streamer.stateOf(sectorId);
  }

  abstractPopOf(sectorId: number): number {
    return this.sector(sectorId).abstractPop;
  }

  liveCountOf(sectorId: number): number {
    return this.sector(sectorId).liveCount;
  }

  /** Total abstract (offscreen) population across the district. */
  abstractTotal(): number {
    let n = 0;
    for (const s of this.sectors.values()) n += s.abstractPop;
    return n;
  }

  /** Total live (streamed-in) population the runtime should currently have simulating. */
  liveTotal(): number {
    let n = 0;
    for (const s of this.sectors.values()) n += s.liveCount;
    return n;
  }

  /** Sectors currently streamed in to sim-active (diagnostics / streaming budget). */
  activeSectorCount(): number {
    return this.streamer.countInState('sim-active');
  }

  /** The sector whose centre is nearest a world position (objective placement / spawn routing). */
  nearestSector(x: number, z: number): SectorDescriptor {
    let best: SectorRuntime | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const s of this.sectors.values()) {
      const d = Math.hypot(s.desc.centerX - x, s.desc.centerZ - z);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best!.desc;
  }

  /**
   * Stream the district around the player. Activates near sectors (promoting a capped abstract slice to
   * live), cools far ones, and evicts cooled sectors past their dwell (folding live members back to
   * abstract). Counts mutate here deterministically; the returned plan tells the runtime exactly which
   * entities to spawn/despawn. `tick` stamps cooling for the eviction dwell.
   */
  update(playerX: number, playerZ: number, tick: number): StreamingPlan {
    const promotions: SectorPromotion[] = [];
    const evictions: SectorEviction[] = [];

    for (const s of this.sectors.values()) {
      const d = Math.hypot(s.desc.centerX - playerX, s.desc.centerZ - playerZ);
      const state = this.streamer.stateOf(s.desc.id);
      const near = d <= this.settings.activateRadiusMeters;
      const far = d > this.settings.evictRadiusMeters;

      if (near) {
        if (state === 'unloaded') {
          warmToSimActive(this.streamer, s.desc.id);
          const count = Math.min(this.settings.promotedPerSectorCap, s.abstractPop);
          if (count > 0) {
            s.abstractPop -= count;
            s.liveCount += count;
            promotions.push({ sectorId: s.desc.id, count, centerX: s.desc.centerX, centerZ: s.desc.centerZ });
          }
        } else if (state === 'cooling') {
          // Player returned before eviction — re-warm without re-promoting (live members are still live).
          this.streamer.transition(s.desc.id, 'sim-active', tick);
        }
      } else if (far) {
        if (state === 'sim-active') {
          this.streamer.transition(s.desc.id, 'cooling', tick);
        } else if (state === 'cooling' && this.streamer.readyToEvict(s.desc.id, tick)) {
          this.streamer.transition(s.desc.id, 'persisted-evicted', tick); // disposes resources (V24)
          this.streamer.transition(s.desc.id, 'unloaded', tick); // ready to re-stream later
          const count = s.liveCount;
          if (count > 0) {
            s.liveCount = 0;
            s.abstractPop += count;
            evictions.push({ sectorId: s.desc.id, count });
          }
        }
      }
    }

    return { promotions, evictions };
  }

  /** Capture per-sector population for persistence (V9). */
  save(): SectorPopulationSave[] {
    return [...this.sectors.values()].map((s) => ({
      sectorId: s.desc.id,
      abstractPop: s.abstractPop,
      liveCount: s.liveCount,
    }));
  }

  /** Restore per-sector population from a save (unknown sectors are ignored — base may have changed). */
  restore(saved: readonly SectorPopulationSave[]): void {
    for (const r of saved) {
      const s = this.sectors.get(r.sectorId);
      if (!s) continue;
      s.abstractPop = Math.max(0, r.abstractPop);
      s.liveCount = Math.max(0, r.liveCount);
    }
  }

  private sector(sectorId: number): SectorRuntime {
    const s = this.sectors.get(sectorId);
    if (!s) throw new Error(`unknown sector ${sectorId}`);
    return s;
  }
}
