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

  // ---- T18 firearm: ammo + line-of-fire penetration + report sound (V16/V28) ----
  /** Rounds a firearm magazine holds; firing with an empty magazine fails (no silent infinite ammo). */
  firearmMagazineSize: num({
    owner: 'weapons',
    unit: 'count',
    doc: 'Rounds per firearm magazine; an empty magazine cannot fire (T18 ammo).',
    default: 12,
    min: 1,
    max: 1000,
    integer: true,
  }),
  /** Max bodies one shot passes through (line-of-fire penetration), ordered by travel (V16). */
  firearmMaxPenetrations: num({
    owner: 'weapons',
    unit: 'count',
    doc: 'Maximum bodies a single shot penetrates along the line of fire, ordered by travel (V16).',
    default: 2,
    min: 1,
    max: 50,
    integer: true,
  }),
  /** Damage retained after passing through each penetrated body (line-of-fire falloff, V16). */
  firearmPenetrationDamageFalloff: num({
    owner: 'weapons',
    unit: 'ratio',
    doc: 'Fraction of damage retained after each penetrated body along the line of fire.',
    default: 0.6,
    min: 0,
    max: 1,
  }),
  /** Intensity of the gunfire sound stimulus emitted on each shot (V28 audio-as-stimulus). */
  gunfireSoundIntensity: num({
    owner: 'weapons',
    unit: 'ratio',
    doc: 'Normalized intensity of the gunfire sound stimulus emitted per shot (V28).',
    default: 1,
    min: 0,
    max: 1,
  }),
  /** Birth radius of the gunfire sound stimulus (meters) — how far the report can attract a horde. */
  gunfireSoundRadiusMeters: num({
    owner: 'weapons',
    unit: 'meters',
    doc: 'Birth radius of the gunfire sound stimulus (V28 propagation seed).',
    default: 80,
    min: 1,
    max: 2000,
  }),
  /** Intensity loss per tick for an emitted weapon sound stimulus. */
  weaponSoundDecayPerTick: num({
    owner: 'weapons',
    unit: 'ratio',
    doc: 'Intensity lost per tick by an emitted weapon sound stimulus before it retires.',
    default: 0.05,
    min: 0.001,
    max: 1,
  }),

  // ---- T18 melee sweep: arc + reach + impact sound (V16/V28) ----
  /** Base melee damage per connecting swing, before region multiplier + armor. */
  meleeDamage: num({
    owner: 'weapons',
    unit: 'count',
    doc: 'Base melee damage per connecting swing, before region multiplier and armor (T18).',
    default: 45,
    min: 1,
    max: 100_000,
  }),
  /** Reach of the melee sweep volume (meters from the attacker). */
  meleeRangeMeters: num({
    owner: 'weapons',
    unit: 'meters',
    doc: 'Reach of the melee sweep attack volume (meters from attacker).',
    default: 1.8,
    min: 0.2,
    max: 12,
  }),
  /** Full angular width of the melee sweep arc (degrees) centered on the swing direction. */
  meleeArcDegrees: num({
    owner: 'weapons',
    unit: 'degrees',
    doc: 'Full angular width of the melee sweep arc centered on the swing direction.',
    default: 120,
    min: 1,
    max: 360,
  }),
  /** Fraction of a target's armor a melee strike ignores (penetration term). */
  meleeArmorPenetration: num({
    owner: 'weapons',
    unit: 'ratio',
    doc: 'Fraction of target armor ignored by a melee strike (0 = none, 1 = full).',
    default: 0.25,
    min: 0,
    max: 1,
  }),
  /** Intensity of the melee impact sound stimulus (quieter than gunfire, V28). */
  meleeSoundIntensity: num({
    owner: 'weapons',
    unit: 'ratio',
    doc: 'Normalized intensity of the melee impact sound stimulus (V28).',
    default: 0.4,
    min: 0,
    max: 1,
  }),
  /** Birth radius of the melee impact sound stimulus (meters). */
  meleeSoundRadiusMeters: num({
    owner: 'weapons',
    unit: 'meters',
    doc: 'Birth radius of the melee impact sound stimulus (V28).',
    default: 12,
    min: 1,
    max: 500,
  }),
});
