// T20 / V14 / V19 — horde group intent / density / momentum / attraction + structural pressure.
// A horde is NOT one inseparable entity (V14): every figure below is DERIVED from its member set;
// members keep their own slot, state, target and anatomy. The aggregate gives the crowd a shared
// intent (attraction point), a momentum (mean velocity) and a density (pressure) — enough for
// flow-field grouping (V15) and for the emergent "press on the door" behaviour (V19) without
// collapsing the members into a single object.

import { resolveDomain } from '@/config/registry';
import { hordesConfig } from '@/config/domains/hordes';
import { combatConfig } from '@/config/domains/combat';
import type { QualityTier, ResolvedDomain } from '@/config/types';

const REFERENCE_TIER: QualityTier = 'desktop-high';

export interface HordeMember {
  readonly x: number;
  readonly z: number;
  readonly vx: number;
  readonly vz: number;
}

/** One member's strongest current attractor (its best perceived stimulus origin + intensity). */
export interface MemberAttractor {
  readonly x: number;
  readonly z: number;
  readonly intensity: number;
}

export interface HordeSummary {
  readonly count: number;
  readonly centroidX: number;
  readonly centroidZ: number;
  /** Mean velocity vector (shared momentum) + its magnitude. */
  readonly momentumX: number;
  readonly momentumZ: number;
  readonly speed: number;
  /** Members per occupied broad-phase cell. */
  readonly density: number;
  /** Density at/above the configured crowd-pressure threshold (V19). */
  readonly underPressure: boolean;
  /** The cluster is large enough to be driven as one shared flow-field group (V15). */
  readonly isGroup: boolean;
}

/** Summarize a member set into shared group figures (V14/V15/V19). */
export function summarizeHorde(
  members: readonly HordeMember[],
  occupiedCellCount: number,
  tier: QualityTier = REFERENCE_TIER,
): HordeSummary {
  const h = resolveDomain(hordesConfig, tier);
  const n = members.length;
  if (n === 0) {
    return {
      count: 0, centroidX: 0, centroidZ: 0, momentumX: 0, momentumZ: 0,
      speed: 0, density: 0, underPressure: false, isGroup: false,
    };
  }
  let cx = 0, cz = 0, mx = 0, mz = 0;
  for (const m of members) {
    cx += m.x; cz += m.z; mx += m.vx; mz += m.vz;
  }
  cx /= n; cz /= n; mx /= n; mz /= n;
  const density = n / Math.max(1, occupiedCellCount);
  return {
    count: n,
    centroidX: cx,
    centroidZ: cz,
    momentumX: mx,
    momentumZ: mz,
    speed: Math.hypot(mx, mz),
    density,
    underPressure: density >= h.crowdPressureDensity,
    isGroup: n >= h.minGroupSize,
  };
}

/**
 * Shared group attraction point: the intensity-weighted centroid of members' individual attractors
 * (V14 — built bottom-up from per-member perception, never from omniscient coords). Returns null
 * when no member currently perceives anything.
 */
export function groupAttraction(attractors: readonly MemberAttractor[]): { x: number; z: number; intensity: number } | null {
  let wx = 0, wz = 0, w = 0, peak = 0;
  for (const a of attractors) {
    if (a.intensity <= 0) continue;
    wx += a.x * a.intensity;
    wz += a.z * a.intensity;
    w += a.intensity;
    if (a.intensity > peak) peak = a.intensity;
  }
  if (w <= 0) return null;
  return { x: wx / w, z: wz / w, intensity: peak };
}

/** A structure that absorbs crowd pressure as damage (wired by the runtime to a StructuralModule). */
export interface BarricadeSink {
  applyDamage(amount: number): void;
}

/**
 * Accumulates repeated crowd pressure against a barricade/door and releases structural damage in
 * increments once the pressure threshold is crossed (V19). A single tick of light pressure does
 * nothing; sustained pressure from many members breaks the barricade over time.
 */
export class BarricadePressure {
  private acc = 0;
  private readonly perMemberPerTick: number;
  private readonly threshold: number;
  private readonly damagePerThreshold: number;

  constructor(tier: QualityTier = REFERENCE_TIER, cfg?: ResolvedDomain<typeof combatConfig>) {
    const c = cfg ?? resolveDomain(combatConfig, tier);
    this.perMemberPerTick = c.barricadePressurePerMemberPerTick;
    this.threshold = c.barricadePressureThreshold;
    this.damagePerThreshold = c.barricadeDamagePerThreshold;
  }

  get accumulated(): number {
    return this.acc;
  }

  /** Apply one tick of pressure from `pressingMembers`; returns structural damage released this tick. */
  tick(pressingMembers: number): number {
    if (pressingMembers < 0) throw new Error(`pressingMembers must be >= 0, got ${pressingMembers}`);
    this.acc += pressingMembers * this.perMemberPerTick;
    let dmg = 0;
    while (this.acc >= this.threshold) {
      this.acc -= this.threshold;
      dmg += this.damagePerThreshold;
    }
    return dmg;
  }

  /** Apply one tick of pressure and forward any released damage to the barricade (V19). */
  tickInto(pressingMembers: number, sink: BarricadeSink): number {
    const dmg = this.tick(pressingMembers);
    if (dmg > 0) sink.applyDamage(dmg);
    return dmg;
  }
}
