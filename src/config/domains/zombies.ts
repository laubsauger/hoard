// Config domain: zombies. Owned by lane S. SoA capacity + tier-assignment thresholds (T8/T10).
// V13 — tier assignment depends on distance/visibility/threat/camera/target/damage/attack/perf budget.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const zombiesConfig = registerDomain('zombies', {
  /** SoA backing-store capacity (max simultaneously addressable zombies in a loaded set). */
  capacity: num({
    owner: 'zombies',
    unit: 'count',
    doc: 'Maximum simultaneously addressable zombies in the SoA store.',
    default: 5000,
    min: 1,
    max: 200_000,
    integer: true,
    tiers: { 'mobile-webgpu': 1500 },
  }),
  /** Distance below which a zombie is a Tier-0 hero candidate (full fidelity). */
  heroDistance: num({
    owner: 'zombies',
    unit: 'meters',
    doc: 'Max distance for a Tier-0 hero candidate.',
    default: 12,
    min: 1,
    max: 64,
  }),
  /** Distance below which a zombie is at most Tier-1 active-crowd. */
  activeDistance: num({
    owner: 'zombies',
    unit: 'meters',
    doc: 'Max distance for a Tier-1 active-crowd candidate.',
    default: 40,
    min: 4,
    max: 200,
  }),
  /** Distance below which a zombie is at most Tier-2 visible-horde; beyond is Tier-3 abstract. */
  hordeDistance: num({
    owner: 'zombies',
    unit: 'meters',
    doc: 'Max distance for a Tier-2 visible-horde candidate; beyond becomes Tier-3 abstract.',
    default: 120,
    min: 8,
    max: 1000,
  }),
  /** Threat level (0..1) at/above which a zombie is promoted one tier toward hero. */
  threatPromoteLevel: num({
    owner: 'zombies',
    unit: 'ratio',
    doc: 'Threat level at/above which a zombie is promoted one tier.',
    default: 0.6,
    min: 0,
    max: 1,
  }),
  /** Camera-importance (0..1) at/above which a zombie is promoted one tier. */
  cameraPromoteLevel: num({
    owner: 'zombies',
    unit: 'ratio',
    doc: 'Camera-importance at/above which a zombie is promoted one tier.',
    default: 0.7,
    min: 0,
    max: 1,
  }),
  /** Perf budget (0..1) below which discretionary promotions are suppressed (demotion pressure). */
  perfBudgetFloor: num({
    owner: 'zombies',
    unit: 'ratio',
    doc: 'Available perf budget below which discretionary hero promotions are suppressed.',
    default: 0.2,
    min: 0,
    max: 1,
  }),

  // ---- T21 archetype stats (data-composed; every tunable typed — V4/V7) ----
  // shambler — slow, durable baseline.
  shamblerMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Shambler locomotion speed.', default: 1.2, min: 0.1, max: 12 }),
  shamblerHealth: num({ owner: 'zombies', unit: 'count', doc: 'Shambler base health.', default: 100, min: 1, max: 10_000 }),
  shamblerArmor: num({ owner: 'zombies', unit: 'count', doc: 'Shambler flat armor.', default: 10, min: 0, max: 1000 }),
  shamblerSightRange: num({ owner: 'zombies', unit: 'meters', doc: 'Shambler sight range.', default: 18, min: 1, max: 200 }),
  shamblerHearingRange: num({ owner: 'zombies', unit: 'meters', doc: 'Shambler hearing range.', default: 36, min: 1, max: 500 }),
  shamblerAttackDamage: num({ owner: 'zombies', unit: 'count', doc: 'Shambler melee attack damage.', default: 8, min: 0, max: 10_000 }),
  shamblerAttackCooldownSeconds: num({ owner: 'zombies', unit: 'seconds', doc: 'Seconds between consecutive shambler attacks on a reached target (V17 attack cadence).', default: 1.5, min: 0.05, max: 30 }),
  shamblerSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Shambler sever-threshold scale (anatomical damage variation).', default: 1, min: 0.1, max: 10 }),

  // runner — fast, fragile, agitated.
  runnerMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Runner locomotion speed.', default: 4.2, min: 0.1, max: 12 }),
  runnerHealth: num({ owner: 'zombies', unit: 'count', doc: 'Runner base health.', default: 70, min: 1, max: 10_000 }),
  runnerArmor: num({ owner: 'zombies', unit: 'count', doc: 'Runner flat armor.', default: 4, min: 0, max: 1000 }),
  runnerSightRange: num({ owner: 'zombies', unit: 'meters', doc: 'Runner sight range.', default: 28, min: 1, max: 200 }),
  runnerHearingRange: num({ owner: 'zombies', unit: 'meters', doc: 'Runner hearing range.', default: 48, min: 1, max: 500 }),
  runnerAttackDamage: num({ owner: 'zombies', unit: 'count', doc: 'Runner melee attack damage.', default: 12, min: 0, max: 10_000 }),
  runnerAttackCooldownSeconds: num({ owner: 'zombies', unit: 'seconds', doc: 'Seconds between consecutive runner attacks on a reached target (faster, agitated cadence).', default: 0.9, min: 0.05, max: 30 }),
  runnerSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Runner sever-threshold scale (fragile — easier to sever).', default: 0.7, min: 0.1, max: 10 }),

  // crawler — already legless, low/ground posture, durable torso.
  crawlerMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Crawler locomotion speed (low to ground).', default: 0.7, min: 0.1, max: 12 }),
  crawlerHealth: num({ owner: 'zombies', unit: 'count', doc: 'Crawler base health.', default: 90, min: 1, max: 10_000 }),
  crawlerArmor: num({ owner: 'zombies', unit: 'count', doc: 'Crawler flat armor.', default: 8, min: 0, max: 1000 }),
  crawlerSightRange: num({ owner: 'zombies', unit: 'meters', doc: 'Crawler sight range (eyes near ground).', default: 10, min: 1, max: 200 }),
  crawlerHearingRange: num({ owner: 'zombies', unit: 'meters', doc: 'Crawler hearing range.', default: 30, min: 1, max: 500 }),
  crawlerAttackDamage: num({ owner: 'zombies', unit: 'count', doc: 'Crawler melee attack damage (grab/bite).', default: 10, min: 0, max: 10_000 }),
  crawlerAttackCooldownSeconds: num({ owner: 'zombies', unit: 'seconds', doc: 'Seconds between consecutive crawler attacks (low grab/bite cadence).', default: 1.2, min: 0.05, max: 30 }),
  crawlerSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Crawler sever-threshold scale (tough torso/arms).', default: 1.4, min: 0.1, max: 10 }),

  // armored (emergency-personnel) — slow, very tanky body + flat armor; head still fatal → forces headshots/penetration.
  armoredMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Armored locomotion speed (weighed down by gear).', default: 1.0, min: 0.1, max: 12 }),
  armoredHealth: num({ owner: 'zombies', unit: 'count', doc: 'Armored base health (high — tanky body).', default: 140, min: 1, max: 10_000 }),
  armoredArmor: num({ owner: 'zombies', unit: 'count', doc: 'Armored flat armor (riot/EMS gear — heavily mitigates body hits).', default: 60, min: 0, max: 1000 }),
  armoredSightRange: num({ owner: 'zombies', unit: 'meters', doc: 'Armored sight range.', default: 16, min: 1, max: 200 }),
  armoredHearingRange: num({ owner: 'zombies', unit: 'meters', doc: 'Armored hearing range.', default: 30, min: 1, max: 500 }),
  armoredAttackDamage: num({ owner: 'zombies', unit: 'count', doc: 'Armored melee attack damage.', default: 10, min: 0, max: 10_000 }),
  armoredAttackCooldownSeconds: num({ owner: 'zombies', unit: 'seconds', doc: 'Seconds between consecutive armored attacks (slow, heavy cadence).', default: 1.8, min: 0.05, max: 30 }),
  armoredSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Armored sever-threshold scale (body very hard to sever — gear protects limbs).', default: 2.2, min: 0.1, max: 10 }),

  // decayed — far gone, low health, falls apart easily (very low sever threshold), shambling.
  decayedMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Decayed locomotion speed (frail shamble).', default: 1.0, min: 0.1, max: 12 }),
  decayedHealth: num({ owner: 'zombies', unit: 'count', doc: 'Decayed base health (low — rotted, fragile).', default: 45, min: 1, max: 10_000 }),
  decayedArmor: num({ owner: 'zombies', unit: 'count', doc: 'Decayed flat armor (none — flesh has rotted away).', default: 0, min: 0, max: 1000 }),
  decayedSightRange: num({ owner: 'zombies', unit: 'meters', doc: 'Decayed sight range (clouded eyes).', default: 12, min: 1, max: 200 }),
  decayedHearingRange: num({ owner: 'zombies', unit: 'meters', doc: 'Decayed hearing range.', default: 28, min: 1, max: 500 }),
  decayedAttackDamage: num({ owner: 'zombies', unit: 'count', doc: 'Decayed melee attack damage (weak).', default: 6, min: 0, max: 10_000 }),
  decayedAttackCooldownSeconds: num({ owner: 'zombies', unit: 'seconds', doc: 'Seconds between consecutive decayed attacks (sluggish cadence).', default: 1.6, min: 0.05, max: 30 }),
  decayedSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Decayed sever-threshold scale (very low — limbs come off easily).', default: 0.4, min: 0.1, max: 10 }),

  // burned — charred; brittle flesh, emits ash not blood (gore type), moderate stats.
  burnedMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Burned locomotion speed.', default: 1.3, min: 0.1, max: 12 }),
  burnedHealth: num({ owner: 'zombies', unit: 'count', doc: 'Burned base health (moderate).', default: 80, min: 1, max: 10_000 }),
  burnedArmor: num({ owner: 'zombies', unit: 'count', doc: 'Burned flat armor (charred crust).', default: 6, min: 0, max: 1000 }),
  burnedSightRange: num({ owner: 'zombies', unit: 'meters', doc: 'Burned sight range.', default: 16, min: 1, max: 200 }),
  burnedHearingRange: num({ owner: 'zombies', unit: 'meters', doc: 'Burned hearing range.', default: 32, min: 1, max: 500 }),
  burnedAttackDamage: num({ owner: 'zombies', unit: 'count', doc: 'Burned melee attack damage.', default: 9, min: 0, max: 10_000 }),
  burnedAttackCooldownSeconds: num({ owner: 'zombies', unit: 'seconds', doc: 'Seconds between consecutive burned attacks.', default: 1.4, min: 0.05, max: 30 }),
  burnedSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Burned sever-threshold scale (brittle, charred — slightly easier to sever).', default: 0.9, min: 0.1, max: 10 }),

  // bloated — slow, swollen; splits easily and bursts on death (death effect hook, render later).
  bloatedMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Bloated locomotion speed (very slow, swollen).', default: 0.9, min: 0.1, max: 12 }),
  bloatedHealth: num({ owner: 'zombies', unit: 'count', doc: 'Bloated base health (high — distended mass).', default: 110, min: 1, max: 10_000 }),
  bloatedArmor: num({ owner: 'zombies', unit: 'count', doc: 'Bloated flat armor (soft, none to speak of).', default: 2, min: 0, max: 1000 }),
  bloatedSightRange: num({ owner: 'zombies', unit: 'meters', doc: 'Bloated sight range.', default: 10, min: 1, max: 200 }),
  bloatedHearingRange: num({ owner: 'zombies', unit: 'meters', doc: 'Bloated hearing range.', default: 26, min: 1, max: 500 }),
  bloatedAttackDamage: num({ owner: 'zombies', unit: 'count', doc: 'Bloated melee attack damage.', default: 7, min: 0, max: 10_000 }),
  bloatedAttackCooldownSeconds: num({ owner: 'zombies', unit: 'seconds', doc: 'Seconds between consecutive bloated attacks (ponderous cadence).', default: 2.0, min: 0.05, max: 30 }),
  bloatedSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Bloated sever-threshold scale (taut skin splits easily).', default: 0.6, min: 0.1, max: 10 }),

  // ---- T54/T55 / B9 corpse persistence (a killed zombie leaves a lingering body, never popping out) ----
  /** Max simultaneous corpse records held by the CorpseSystem (pooled + capped; oldest recycled). */
  corpseCapacity: num({
    owner: 'zombies',
    unit: 'count',
    doc: 'Maximum simultaneous corpse records (pooled, capped; the oldest is recycled when full).',
    default: 512,
    min: 1,
    max: 50_000,
    integer: true,
    tiers: { 'mobile-webgpu': 192 },
  }),
  /** Ticks a corpse lingers before it is cleaned up (long — bodies persist, then fade out). */
  corpseLifetimeTicks: num({
    owner: 'zombies',
    unit: 'ticks',
    doc: 'Authoritative ticks a corpse lingers before cleanup (long-lived; bodies do not vanish on death).',
    default: 9000, // ~5 min at the 30 Hz default tick rate
    min: 1,
    max: 1_080_000,
    integer: true,
    tiers: { 'mobile-webgpu': 5400 },
  }),
});
