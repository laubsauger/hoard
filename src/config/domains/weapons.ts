// Config domain: weapons. Owned by lane S (forward-pulled subset for GATE-0 / T41; full T18 later).
// V4 — every firearm tunable is typed with unit+owner+default+range; no literals in the hit path.
// V16 — firearm hit pipeline reads these to gather/order candidates and resolve region damage.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const weaponsConfig = registerDomain('weapons', {
  /** Base damage a single firearm shot deals before region multiplier + armor. */
  firearmDamage: num({
    owner: 'weapons',
    unit: 'count',
    doc: 'Base firearm damage per shot, before anatomical-region multiplier and armor (T18 subset).',
    default: 60,
    min: 1,
    max: 100_000,
  }),
  /** Maximum travel of a firearm ray/sweep query. Candidates beyond this are not gathered (V16). */
  firearmRangeMeters: num({
    owner: 'weapons',
    unit: 'meters',
    doc: 'Maximum firearm ray travel; candidates ordered by travel are filtered to within this range.',
    default: 60,
    min: 1,
    max: 1000,
  }),
  /** Lateral radius around the ray within which a body is a hit candidate (line-of-fire width). */
  firearmHitRadiusMeters: num({
    owner: 'weapons',
    unit: 'meters',
    doc: 'Lateral distance from the ray line within which a body is considered struck.',
    default: 0.5,
    min: 0.05,
    max: 5,
  }),
  /** Fraction of a target's armor a firearm shot ignores (penetration, V16). */
  firearmArmorPenetration: num({
    owner: 'weapons',
    unit: 'ratio',
    doc: 'Fraction of the target armor ignored by a firearm shot (0 = none, 1 = full penetration).',
    default: 0.5,
    min: 0,
    max: 1,
  }),
  /** Damage multiplier for a head-region hit (also governs sever; head fatality is in combat config). */
  headshotMultiplier: num({
    owner: 'weapons',
    unit: 'ratio',
    doc: 'Damage multiplier applied to a head/neck region hit.',
    default: 3,
    min: 1,
    max: 20,
  }),
  /** Damage multiplier for a torso-region hit. */
  torsoMultiplier: num({
    owner: 'weapons',
    unit: 'ratio',
    doc: 'Damage multiplier applied to a torso region hit.',
    default: 1,
    min: 0.1,
    max: 10,
  }),
  /** Damage multiplier for a limb-region hit (lower lethality, more likely to sever). */
  limbMultiplier: num({
    owner: 'weapons',
    unit: 'ratio',
    doc: 'Damage multiplier applied to an arm/leg region hit.',
    default: 0.6,
    min: 0.1,
    max: 10,
  }),
});
