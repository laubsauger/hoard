// T27 / V28 — coarse sector sound graph for long-range spread. Sectors are nodes; doors / windows /
// breaches / floors / walls are attenuation LINKS (each retains a configured fraction of intensity).
// propagate() finds the best (loudest) intensity reaching each sector — the expensive ray/portal
// refine is left to the active area; this graph is the cheap long-range layer. Sound below
// minPropagatedIntensity stops spreading.

import { resolveDomain } from '@/config/registry';
import { audioConfig } from '@/config/domains/audio';
import type { QualityTier, ResolvedDomain } from '@/config/types';

export type AudioSettings = ResolvedDomain<typeof audioConfig>;

const REFERENCE_TIER: QualityTier = 'desktop-high';

export type LinkType = 'door' | 'window' | 'breach' | 'floor' | 'wall';

interface Link {
  readonly to: number;
  readonly type: LinkType;
}

export class SectorSoundGraph {
  readonly settings: AudioSettings;
  private readonly adjacency = new Map<number, Link[]>();

  constructor(tier: QualityTier = REFERENCE_TIER) {
    this.settings = resolveDomain(audioConfig, tier);
  }

  private attenuation(type: LinkType): number {
    const s = this.settings;
    switch (type) {
      case 'door': return s.doorAttenuation;
      case 'window': return s.windowAttenuation;
      case 'breach': return s.breachAttenuation;
      case 'floor': return s.floorAttenuation;
      case 'wall': return s.wallAttenuation;
    }
  }

  addSector(sector: number): void {
    if (!this.adjacency.has(sector)) this.adjacency.set(sector, []);
  }

  /** Bidirectional attenuation link between two sectors. */
  addLink(a: number, b: number, type: LinkType): void {
    if (a === b) throw new Error(`a sound link cannot connect a sector to itself (${a})`);
    this.addSector(a);
    this.addSector(b);
    this.adjacency.get(a)!.push({ to: b, type });
    this.adjacency.get(b)!.push({ to: a, type });
  }

  /**
   * Propagate `intensity` from `origin`. Returns the best intensity reaching each reachable sector.
   * Best-first relaxation: since every link multiplies by a factor in [0,1], intensity is monotone
   * non-increasing, so the first time we pop a sector we have its loudest arrival.
   */
  propagate(origin: number, intensity: number): Map<number, number> {
    if (intensity < 0 || intensity > 1 || Number.isNaN(intensity)) {
      throw new Error(`origin intensity must be in [0,1], got ${intensity}`);
    }
    if (!this.adjacency.has(origin)) throw new Error(`unknown origin sector ${origin}`);
    const best = new Map<number, number>([[origin, intensity]]);
    const settled = new Set<number>();
    const floor = this.settings.minPropagatedIntensity;

    while (settled.size < best.size) {
      // pick the loudest unsettled sector.
      let cur = -1;
      let curVal = -1;
      for (const [sector, val] of best) {
        if (settled.has(sector)) continue;
        if (val > curVal) { curVal = val; cur = sector; }
      }
      if (cur === -1) break;
      settled.add(cur);
      if (curVal < floor) continue;
      for (const link of this.adjacency.get(cur) ?? []) {
        const reached = curVal * this.attenuation(link.type);
        if (reached < floor) continue;
        if (reached > (best.get(link.to) ?? 0)) best.set(link.to, reached);
      }
    }
    return best;
  }
}
