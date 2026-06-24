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
  // T124/V89 — the SPAWNED roster is the STANDARD / BLOATED / RUNNER trio: a per-archetype move-speed SCALE
  // (multiplier on the shared horde baseline `combat.hordeMoveSpeed`, so STANDARD = 1.0 = unchanged baseline),
  // a per-archetype HEALTH (count, drives hits-to-kill via the SoA per-slot health), and a SPAWN WEIGHT
  // (relative; STANDARD dominant, BLOATED + RUNNER sprinkled). The grounded ecology variants (crawler /
  // armored / decayed / burned) keep zero spawn weight by default — present for content tuning, never spawned
  // until a designer raises their weight. shambler = STANDARD baseline.
  shamblerMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Shambler (STANDARD) nominal locomotion speed (the baseline the other archetypes scale against).', default: 1.4, min: 0.1, max: 12 }),
  shamblerMoveSpeedScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Shambler (STANDARD) move-speed multiplier on the shared horde baseline (combat.hordeMoveSpeed). 1.0 = baseline.', default: 1.0, min: 0.1, max: 6 }),
  shamblerSpawnWeight: num({ owner: 'zombies', unit: 'ratio', doc: 'Shambler (STANDARD) relative spawn weight — DOMINANT (the common zombie, ~70%+ of the mix).', default: 76, min: 0, max: 1000 }),
  shamblerHealth: num({ owner: 'zombies', unit: 'count', doc: 'Shambler (STANDARD) base health — the baseline hits-to-kill.', default: 100, min: 1, max: 10_000 }),
  shamblerArmor: num({ owner: 'zombies', unit: 'count', doc: 'Shambler flat armor.', default: 10, min: 0, max: 1000 }),
  shamblerSightRange: num({ owner: 'zombies', unit: 'meters', doc: 'Shambler sight range.', default: 18, min: 1, max: 200 }),
  shamblerHearingRange: num({ owner: 'zombies', unit: 'meters', doc: 'Shambler hearing range.', default: 36, min: 1, max: 500 }),
  shamblerAttackDamage: num({ owner: 'zombies', unit: 'count', doc: 'Shambler melee attack damage.', default: 8, min: 0, max: 10_000 }),
  shamblerAttackCooldownSeconds: num({ owner: 'zombies', unit: 'seconds', doc: 'Seconds between consecutive shambler attacks on a reached target (V17 attack cadence).', default: 1.5, min: 0.05, max: 30 }),
  shamblerSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Shambler sever-threshold scale (anatomical damage variation).', default: 1, min: 0.1, max: 10 }),

  // runner (RUNNER) — FAST, fragile: approaches quickly, dies in fewer hits.
  runnerMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Runner (RUNNER) nominal locomotion speed (= baseline × runnerMoveSpeedScale) ≈ 3.6 m/s — near the player WALK (3.8), so a runner is a real chase you must SPRINT to escape.', default: 3.64, min: 0.1, max: 12 }),
  runnerMoveSpeedScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Runner (RUNNER) move-speed multiplier vs the STANDARD baseline. 2.6 (was 1.6, read "almost normal speed"): a runner clearly OUTPACES a shambler and nearly matches the player walk.', default: 2.6, min: 0.1, max: 6 }),
  runnerSpawnWeight: num({ owner: 'zombies', unit: 'ratio', doc: 'Runner (RUNNER) relative spawn weight — SPRINKLED (low; fast threat punctuates the standard mix).', default: 12, min: 0, max: 1000 }),
  runnerHealth: num({ owner: 'zombies', unit: 'count', doc: 'Runner (RUNNER) base health — LOW (0.5–0.7× standard; fewer hits to kill).', default: 60, min: 1, max: 10_000 }),
  runnerArmor: num({ owner: 'zombies', unit: 'count', doc: 'Runner flat armor.', default: 4, min: 0, max: 1000 }),
  runnerSightRange: num({ owner: 'zombies', unit: 'meters', doc: 'Runner sight range.', default: 28, min: 1, max: 200 }),
  runnerHearingRange: num({ owner: 'zombies', unit: 'meters', doc: 'Runner hearing range.', default: 48, min: 1, max: 500 }),
  runnerAttackDamage: num({ owner: 'zombies', unit: 'count', doc: 'Runner melee attack damage.', default: 12, min: 0, max: 10_000 }),
  runnerAttackCooldownSeconds: num({ owner: 'zombies', unit: 'seconds', doc: 'Seconds between consecutive runner attacks on a reached target (faster, agitated cadence).', default: 0.9, min: 0.05, max: 30 }),
  runnerSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Runner sever-threshold scale (fragile — easier to sever).', default: 0.7, min: 0.1, max: 10 }),

  // crawler — already legless, low/ground posture, durable torso. (Ecology variant — 0 spawn weight by default.)
  crawlerMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Crawler locomotion speed (low to ground).', default: 0.7, min: 0.1, max: 12 }),
  crawlerMoveSpeedScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Crawler move-speed multiplier vs the STANDARD baseline (very slow drag).', default: 0.5, min: 0.1, max: 6 }),
  crawlerSpawnWeight: num({ owner: 'zombies', unit: 'ratio', doc: 'Crawler relative spawn weight (0 = not in the default spawn mix; content-tunable).', default: 0, min: 0, max: 1000 }),
  crawlerHealth: num({ owner: 'zombies', unit: 'count', doc: 'Crawler base health.', default: 90, min: 1, max: 10_000 }),
  crawlerArmor: num({ owner: 'zombies', unit: 'count', doc: 'Crawler flat armor.', default: 8, min: 0, max: 1000 }),
  crawlerSightRange: num({ owner: 'zombies', unit: 'meters', doc: 'Crawler sight range (eyes near ground).', default: 10, min: 1, max: 200 }),
  crawlerHearingRange: num({ owner: 'zombies', unit: 'meters', doc: 'Crawler hearing range.', default: 30, min: 1, max: 500 }),
  crawlerAttackDamage: num({ owner: 'zombies', unit: 'count', doc: 'Crawler melee attack damage (grab/bite).', default: 10, min: 0, max: 10_000 }),
  crawlerAttackCooldownSeconds: num({ owner: 'zombies', unit: 'seconds', doc: 'Seconds between consecutive crawler attacks (low grab/bite cadence).', default: 1.2, min: 0.05, max: 30 }),
  crawlerSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Crawler sever-threshold scale (tough torso/arms).', default: 1.4, min: 0.1, max: 10 }),

  // armored (emergency-personnel) — slow, very tanky body + flat armor; head still fatal → forces headshots/penetration.
  // (Ecology variant — 0 spawn weight by default.)
  armoredMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Armored locomotion speed (weighed down by gear).', default: 1.0, min: 0.1, max: 12 }),
  armoredMoveSpeedScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Armored move-speed multiplier vs the STANDARD baseline (slowed by gear).', default: 0.72, min: 0.1, max: 6 }),
  armoredSpawnWeight: num({ owner: 'zombies', unit: 'ratio', doc: 'Armored relative spawn weight (0 = not in the default spawn mix; content-tunable).', default: 0, min: 0, max: 1000 }),
  armoredHealth: num({ owner: 'zombies', unit: 'count', doc: 'Armored base health (high — tanky body).', default: 140, min: 1, max: 10_000 }),
  armoredArmor: num({ owner: 'zombies', unit: 'count', doc: 'Armored flat armor (riot/EMS gear — heavily mitigates body hits).', default: 60, min: 0, max: 1000 }),
  armoredSightRange: num({ owner: 'zombies', unit: 'meters', doc: 'Armored sight range.', default: 16, min: 1, max: 200 }),
  armoredHearingRange: num({ owner: 'zombies', unit: 'meters', doc: 'Armored hearing range.', default: 30, min: 1, max: 500 }),
  armoredAttackDamage: num({ owner: 'zombies', unit: 'count', doc: 'Armored melee attack damage.', default: 10, min: 0, max: 10_000 }),
  armoredAttackCooldownSeconds: num({ owner: 'zombies', unit: 'seconds', doc: 'Seconds between consecutive armored attacks (slow, heavy cadence).', default: 1.8, min: 0.05, max: 30 }),
  armoredSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Armored sever-threshold scale (body very hard to sever — gear protects limbs).', default: 2.2, min: 0.1, max: 10 }),

  // decayed — far gone, low health, falls apart easily (very low sever threshold), shambling.
  // (Ecology variant — 0 spawn weight by default.)
  decayedMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Decayed locomotion speed (frail shamble).', default: 1.0, min: 0.1, max: 12 }),
  decayedMoveSpeedScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Decayed move-speed multiplier vs the STANDARD baseline (frail shamble).', default: 0.72, min: 0.1, max: 6 }),
  decayedSpawnWeight: num({ owner: 'zombies', unit: 'ratio', doc: 'Decayed relative spawn weight (0 = not in the default spawn mix; content-tunable).', default: 0, min: 0, max: 1000 }),
  decayedHealth: num({ owner: 'zombies', unit: 'count', doc: 'Decayed base health (low — rotted, fragile).', default: 45, min: 1, max: 10_000 }),
  decayedArmor: num({ owner: 'zombies', unit: 'count', doc: 'Decayed flat armor (none — flesh has rotted away).', default: 0, min: 0, max: 1000 }),
  decayedSightRange: num({ owner: 'zombies', unit: 'meters', doc: 'Decayed sight range (clouded eyes).', default: 12, min: 1, max: 200 }),
  decayedHearingRange: num({ owner: 'zombies', unit: 'meters', doc: 'Decayed hearing range.', default: 28, min: 1, max: 500 }),
  decayedAttackDamage: num({ owner: 'zombies', unit: 'count', doc: 'Decayed melee attack damage (weak).', default: 6, min: 0, max: 10_000 }),
  decayedAttackCooldownSeconds: num({ owner: 'zombies', unit: 'seconds', doc: 'Seconds between consecutive decayed attacks (sluggish cadence).', default: 1.6, min: 0.05, max: 30 }),
  decayedSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Decayed sever-threshold scale (very low — limbs come off easily).', default: 0.4, min: 0.1, max: 10 }),

  // burned — charred; brittle flesh, emits ash not blood (gore type), moderate stats.
  // (Ecology variant — 0 spawn weight by default.)
  burnedMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Burned locomotion speed.', default: 1.3, min: 0.1, max: 12 }),
  burnedMoveSpeedScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Burned move-speed multiplier vs the STANDARD baseline.', default: 0.93, min: 0.1, max: 6 }),
  burnedSpawnWeight: num({ owner: 'zombies', unit: 'ratio', doc: 'Burned relative spawn weight (0 = not in the default spawn mix; content-tunable).', default: 0, min: 0, max: 1000 }),
  burnedHealth: num({ owner: 'zombies', unit: 'count', doc: 'Burned base health (moderate).', default: 80, min: 1, max: 10_000 }),
  burnedArmor: num({ owner: 'zombies', unit: 'count', doc: 'Burned flat armor (charred crust).', default: 6, min: 0, max: 1000 }),
  burnedSightRange: num({ owner: 'zombies', unit: 'meters', doc: 'Burned sight range.', default: 16, min: 1, max: 200 }),
  burnedHearingRange: num({ owner: 'zombies', unit: 'meters', doc: 'Burned hearing range.', default: 32, min: 1, max: 500 }),
  burnedAttackDamage: num({ owner: 'zombies', unit: 'count', doc: 'Burned melee attack damage.', default: 9, min: 0, max: 10_000 }),
  burnedAttackCooldownSeconds: num({ owner: 'zombies', unit: 'seconds', doc: 'Seconds between consecutive burned attacks.', default: 1.4, min: 0.05, max: 30 }),
  burnedSeverScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Burned sever-threshold scale (brittle, charred — slightly easier to sever).', default: 0.9, min: 0.1, max: 10 }),

  // bloated (BLOATED) — SLOW, swollen, TOUGH: takes many more hits to kill, splits/bursts on death.
  bloatedMoveSpeed: num({ owner: 'zombies', unit: 'metersPerSecond', doc: 'Bloated (BLOATED) nominal locomotion speed (= baseline × bloatedMoveSpeedScale).', default: 0.84, min: 0.1, max: 12 }),
  bloatedMoveSpeedScale: num({ owner: 'zombies', unit: 'ratio', doc: 'Bloated (BLOATED) move-speed multiplier vs the STANDARD baseline — SLOWER (0.55–0.65×).', default: 0.6, min: 0.1, max: 6 }),
  bloatedSpawnWeight: num({ owner: 'zombies', unit: 'ratio', doc: 'Bloated (BLOATED) relative spawn weight — SPRINKLED (low; tanky speed-bump in the standard mix).', default: 12, min: 0, max: 1000 }),
  bloatedHealth: num({ owner: 'zombies', unit: 'count', doc: 'Bloated (BLOATED) base health — HIGH (1.8–2.2× standard; many more hits to kill).', default: 200, min: 1, max: 10_000 }),
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
  /** Ticks a fresh corpse takes to COLLAPSE from standing → prone (the render-side death topple, T122/V87). */
  corpseCollapseTicks: num({
    owner: 'zombies',
    unit: 'ticks',
    doc: 'Ticks a killed zombie takes to topple from standing to prone (render-only death collapse, drives the CorpseField pitch/sink ease — NOT a teleport-to-floor). ~15 ticks ≈ 0.5 s at the 30 Hz default rate.',
    default: 15,
    min: 1,
    max: 120,
    integer: true,
  }),
});
