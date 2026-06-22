// T18 / T16 / V16 — tier-appropriate hit-volume geometry.
// A struck zombie is tested against a hit volume whose fidelity matches its sim tier (V16):
//   hero        — head / neck / torsoUpper / torsoLower / armLeft / armRight / legLeft / legRight
//   active-crowd — head / torso(=torsoUpper) / armLeft / armRight / legLeft / legRight
//   visible-horde — head sphere + body capsule (torsoUpper)
//   abstract     — coarse body bounds (torsoUpper)
// The combat pipeline gathers candidates, then resolves the aimed region against THIS set. If the
// aimed region is finer than the tier exposes, the target is either promoted to hero (detailed
// anatomy) or the region is coarsened to the nearest available volume.

import type { AnatomyRegion } from '@/game/core/contracts';
import { SimTier } from '@/game/simulation';

const HERO: readonly AnatomyRegion[] = [
  'head', 'neck', 'torsoUpper', 'torsoLower', 'armLeft', 'armRight', 'legLeft', 'legRight',
];
const ACTIVE: readonly AnatomyRegion[] = [
  'head', 'torsoUpper', 'armLeft', 'armRight', 'legLeft', 'legRight',
];
const HORDE: readonly AnatomyRegion[] = ['head', 'torsoUpper'];
const ABSTRACT: readonly AnatomyRegion[] = ['torsoUpper'];

const TIER_VOLUMES: Readonly<Record<SimTier, readonly AnatomyRegion[]>> = {
  [SimTier.Hero]: HERO,
  [SimTier.ActiveCrowd]: ACTIVE,
  [SimTier.VisibleHorde]: HORDE,
  [SimTier.Abstract]: ABSTRACT,
};

/** Resolvable anatomical regions at a sim tier (V16 hit-volume tiers). */
export function regionsForTier(tier: SimTier): readonly AnatomyRegion[] {
  return TIER_VOLUMES[tier];
}

/** True when `region` is directly resolvable at `tier` (no coarsening needed). */
export function tierExposes(tier: SimTier, region: AnatomyRegion): boolean {
  return TIER_VOLUMES[tier].includes(region);
}

/**
 * A finer region exposed by a lower tier than `tier` requires detailed anatomy — the pipeline
 * promotes the target to hero rather than silently dropping fidelity (V16/V13).
 */
export function needsDetail(tier: SimTier, region: AnatomyRegion): boolean {
  return !tierExposes(tier, region);
}

/** Fallback chain: collapse a fine region toward the coarse volumes a low tier can represent. */
const COARSEN: Readonly<Record<AnatomyRegion, AnatomyRegion>> = {
  head: 'head',
  neck: 'head',
  torsoUpper: 'torsoUpper',
  torsoLower: 'torsoUpper',
  armLeft: 'torsoUpper',
  armRight: 'torsoUpper',
  legLeft: 'torsoUpper',
  legRight: 'torsoUpper',
};

/** Map an aimed region to the nearest region the tier's hit volume can resolve (V16 filter). */
export function coarsenRegion(tier: SimTier, region: AnatomyRegion): AnatomyRegion {
  if (tierExposes(tier, region)) return region;
  let r = region;
  // walk the fallback chain until the tier exposes the collapsed region (head always exists).
  for (let i = 0; i < 4; i++) {
    const next = COARSEN[r];
    if (next === r || tierExposes(tier, next)) return tierExposes(tier, next) ? next : 'torsoUpper';
    r = next;
  }
  return 'torsoUpper';
}

/**
 * Pick an anatomical region from a normalized vertical impact fraction (0 = feet, 1 = top of head)
 * and a lateral side, at hero fidelity. Used by aiming/geometry layers + tests; the firearm/melee
 * paths usually receive an explicit aimed region. Bands are simple + deterministic (V26).
 */
export function regionFromGeometry(
  heightFraction: number,
  side: 'left' | 'right' | 'center',
): AnatomyRegion {
  if (heightFraction < 0 || heightFraction > 1) {
    throw new Error(`heightFraction must be in [0,1], got ${heightFraction}`);
  }
  if (heightFraction >= 0.9) return 'head';
  if (heightFraction >= 0.82) return 'neck';
  if (heightFraction >= 0.55) {
    if (side === 'left') return 'armLeft';
    if (side === 'right') return 'armRight';
    return 'torsoUpper';
  }
  if (heightFraction >= 0.4) return 'torsoLower';
  return side === 'left' ? 'legLeft' : side === 'right' ? 'legRight' : 'legLeft';
}
