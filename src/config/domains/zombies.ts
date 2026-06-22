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
  shamblerSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Shambler sever-threshold scale (anatomical damage variation).', default: 1, min: 0.1, max: 10 }),

  // runner — fast, fragile, agitated.
  runnerMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Runner locomotion speed.', default: 4.2, min: 0.1, max: 12 }),
  runnerHealth: num({ owner: 'zombies', unit: 'count', doc: 'Runner base health.', default: 70, min: 1, max: 10_000 }),
  runnerArmor: num({ owner: 'zombies', unit: 'count', doc: 'Runner flat armor.', default: 4, min: 0, max: 1000 }),
  runnerSightRange: num({ owner: 'zombies', unit: 'meters', doc: 'Runner sight range.', default: 28, min: 1, max: 200 }),
  runnerHearingRange: num({ owner: 'zombies', unit: 'meters', doc: 'Runner hearing range.', default: 48, min: 1, max: 500 }),
  runnerAttackDamage: num({ owner: 'zombies', unit: 'count', doc: 'Runner melee attack damage.', default: 12, min: 0, max: 10_000 }),
  runnerSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Runner sever-threshold scale (fragile — easier to sever).', default: 0.7, min: 0.1, max: 10 }),

  // crawler — already legless, low/ground posture, durable torso.
  crawlerMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Crawler locomotion speed (low to ground).', default: 0.7, min: 0.1, max: 12 }),
  crawlerHealth: num({ owner: 'zombies', unit: 'count', doc: 'Crawler base health.', default: 90, min: 1, max: 10_000 }),
  crawlerArmor: num({ owner: 'zombies', unit: 'count', doc: 'Crawler flat armor.', default: 8, min: 0, max: 1000 }),
  crawlerSightRange: num({ owner: 'zombies', unit: 'meters', doc: 'Crawler sight range (eyes near ground).', default: 10, min: 1, max: 200 }),
  crawlerHearingRange: num({ owner: 'zombies', unit: 'meters', doc: 'Crawler hearing range.', default: 30, min: 1, max: 500 }),
  crawlerAttackDamage: num({ owner: 'zombies', unit: 'count', doc: 'Crawler melee attack damage (grab/bite).', default: 10, min: 0, max: 10_000 }),
  crawlerSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Crawler sever-threshold scale (tough torso/arms).', default: 1.4, min: 0.1, max: 10 }),
});
