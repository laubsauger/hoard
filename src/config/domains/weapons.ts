// Config domain: weapons. Owned by lane S (forward-pulled subset for GATE-0 / T41; full T18 later).
// V4 — every firearm tunable is typed with unit+owner+default+range; no literals in the hit path.
// V16 — firearm hit pipeline reads these to gather/order candidates and resolve region damage.

import { num, bool } from '../spec';
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
  /** Per-SHOT random aim deviation (full cone, degrees) applied to ANY firearm on top of its pellet pattern —
   *  no shot is pixel-perfect. Small: a little scatter for variety, not a wild spray (deterministic, V26). */
  firearmAccuracySpreadDegrees: num({
    owner: 'weapons',
    unit: 'degrees',
    doc: 'Per-shot random aim deviation (full cone) for any firearm — subtle accuracy scatter on top of pellet spread.',
    default: 3,
    min: 0,
    max: 30,
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

  // ---- T73 per-weapon ballistics (V50) ----
  // Each weapon CLASS (pistol / rifle / shotgun / melee) carries its own ballistic model: base damage,
  // effective range, a penetration BUDGET (stopping power) consumed per body it passes through, an
  // angular spread, a per-meter distance damage falloff, a pellet count (>1 = shotgun spread) and an
  // armor-penetration fraction. `CombatSystem.fire` resolves the EQUIPPED class against this model and
  // returns the true stop distance (V50). The pistol class defaults intentionally mirror the GATE-0
  // single-body firearm subset (damage 60 / range 60 / 1-body budget / no spread / no falloff).

  // pistol — moderate damage, stops at 1 body, no spread, no distance falloff (the default class).
  pistolDamage: num({ owner: 'weapons', unit: 'count', doc: 'Pistol base damage per shot before region multiplier + armor (V50).', default: 60, min: 1, max: 100_000 }),
  pistolRangeMeters: num({ owner: 'weapons', unit: 'meters', doc: 'Pistol maximum ray travel (V50).', default: 60, min: 1, max: 1000 }),
  pistolStoppingPower: num({ owner: 'weapons', unit: 'count', doc: 'Pistol penetration budget; consumed per body by its resistance — exhausted budget STOPS the shot (V50).', default: 1, min: 0.1, max: 1000 }),
  pistolSpreadDegrees: num({ owner: 'weapons', unit: 'degrees', doc: 'Pistol full angular spread across pellets (0 = perfectly accurate) (V50).', default: 0, min: 0, max: 90 }),
  pistolDamageFalloffPerMeter: num({ owner: 'weapons', unit: 'ratio', doc: 'Pistol fraction of damage lost per meter of travel (distance falloff) (V50).', default: 0, min: 0, max: 1 }),
  pistolPellets: num({ owner: 'weapons', unit: 'count', doc: 'Pistol projectiles per shot (1 = single ball) (V50).', default: 1, min: 1, max: 64, integer: true }),
  pistolArmorPenetration: num({ owner: 'weapons', unit: 'ratio', doc: 'Fraction of target armor a pistol shot ignores (V50).', default: 0.5, min: 0, max: 1 }),
  pistolKnockback: num({ owner: 'weapons', unit: 'count', doc: 'Pistol ragdoll knockback ENERGY on a kill (T134) — the corpse impulse, decoupled from damage so a pistol topples the body without mangling it. Sane impulse range ~0..15.', default: 4, min: 0, max: 100 }),

  // rifle — high damage + long range, pierces SEVERAL bodies, slow distance falloff.
  rifleDamage: num({ owner: 'weapons', unit: 'count', doc: 'Rifle base damage per shot before region multiplier + armor (V50).', default: 85, min: 1, max: 100_000 }),
  rifleRangeMeters: num({ owner: 'weapons', unit: 'meters', doc: 'Rifle maximum ray travel (V50).', default: 120, min: 1, max: 1000 }),
  rifleStoppingPower: num({ owner: 'weapons', unit: 'count', doc: 'Rifle penetration budget; a high budget pierces several bodies before the shot stops (V50).', default: 4, min: 0.1, max: 1000 }),
  rifleSpreadDegrees: num({ owner: 'weapons', unit: 'degrees', doc: 'Rifle full angular spread across pellets (V50).', default: 0.4, min: 0, max: 90 }),
  rifleDamageFalloffPerMeter: num({ owner: 'weapons', unit: 'ratio', doc: 'Rifle fraction of damage lost per meter of travel (V50).', default: 0.004, min: 0, max: 1 }),
  riflePellets: num({ owner: 'weapons', unit: 'count', doc: 'Rifle projectiles per shot (1 = single bullet) (V50).', default: 1, min: 1, max: 64, integer: true }),
  rifleArmorPenetration: num({ owner: 'weapons', unit: 'ratio', doc: 'Fraction of target armor a rifle shot ignores (V50).', default: 0.85, min: 0, max: 1 }),
  rifleKnockback: num({ owner: 'weapons', unit: 'count', doc: 'Rifle ragdoll knockback ENERGY on a kill (T134) — a sharp high-velocity punch through the body. Sane impulse range ~0..15.', default: 7, min: 0, max: 100 }),

  // shotgun — many low-power pellets in a wide spread, short range, steep distance falloff.
  shotgunDamage: num({ owner: 'weapons', unit: 'count', doc: 'Shotgun base damage PER PELLET before region multiplier + armor (V50). Bumped 20→25 for a tad more close-range punch.', default: 25, min: 1, max: 100_000 }),
  shotgunRangeMeters: num({ owner: 'weapons', unit: 'meters', doc: 'Shotgun maximum ray travel (V50).', default: 25, min: 1, max: 1000 }),
  shotgunStoppingPower: num({ owner: 'weapons', unit: 'count', doc: 'Shotgun PER-PELLET penetration budget; a pellet stops at one body (V50).', default: 1, min: 0.1, max: 1000 }),
  shotgunSpreadDegrees: num({ owner: 'weapons', unit: 'degrees', doc: 'Shotgun full angular spread across the pellet cone (V50). Widened 14→18 for a slightly broader fan.', default: 18, min: 0, max: 90 }),
  shotgunDamageFalloffPerMeter: num({ owner: 'weapons', unit: 'ratio', doc: 'Shotgun fraction of damage lost per meter of travel (steep) (V50).', default: 0.03, min: 0, max: 1 }),
  shotgunPellets: num({ owner: 'weapons', unit: 'count', doc: 'Shotgun pellets per shot (the spread cone) (V50).', default: 8, min: 1, max: 64, integer: true }),
  shotgunArmorPenetration: num({ owner: 'weapons', unit: 'ratio', doc: 'Fraction of target armor a shotgun pellet ignores (V50).', default: 0.3, min: 0, max: 1 }),
  shotgunKnockback: num({ owner: 'weapons', unit: 'count', doc: 'Shotgun ragdoll knockback ENERGY on a kill (T134) — the heavy close-range blast that LAUNCHES the corpse back hardest. Sane impulse range ~0..15.', default: 13, min: 0, max: 100 }),

  // melee — close range, stops at the first body, mirrors the T18 melee damage/reach as a fire class.
  meleeClassDamage: num({ owner: 'weapons', unit: 'count', doc: 'Melee weapon-class base damage per strike before region multiplier + armor (V50).', default: 45, min: 1, max: 100_000 }),
  meleeClassRangeMeters: num({ owner: 'weapons', unit: 'meters', doc: 'Melee weapon-class reach (V50).', default: 1.8, min: 0.2, max: 12 }),
  meleeClassStoppingPower: num({ owner: 'weapons', unit: 'count', doc: 'Melee weapon-class penetration budget; a strike connects with one body (V50).', default: 1, min: 0.1, max: 1000 }),
  meleeClassSpreadDegrees: num({ owner: 'weapons', unit: 'degrees', doc: 'Melee weapon-class spread (0 — a single directed strike via fire; the arc sweep lives in meleeArcDegrees) (V50).', default: 0, min: 0, max: 90 }),
  meleeClassDamageFalloffPerMeter: num({ owner: 'weapons', unit: 'ratio', doc: 'Melee weapon-class distance falloff (0 over its short reach) (V50).', default: 0, min: 0, max: 1 }),
  meleeClassPellets: num({ owner: 'weapons', unit: 'count', doc: 'Melee weapon-class strikes per swing (1) (V50).', default: 1, min: 1, max: 64, integer: true }),
  meleeClassArmorPenetration: num({ owner: 'weapons', unit: 'ratio', doc: 'Fraction of target armor a melee strike ignores (V50).', default: 0.25, min: 0, max: 1 }),
  meleeClassKnockback: num({ owner: 'weapons', unit: 'count', doc: 'Melee weapon-class ragdoll knockback ENERGY on a kill (T134) — a blunt shove that tips the body over. Sane impulse range ~0..15.', default: 6, min: 0, max: 100 }),

  // ---- T74 ammo / reload / weapon-switch (extends the T73 per-weapon ballistics, V50) ----
  // Each FIREARM class carries a magazine (rounds chambered) plus a finite reserve; one `fire` consumes
  // exactly ONE round — a shotgun spends one SHELL for its whole pellet pattern (one fire = one shell).
  // `reload` moves rounds reserve->magazine over reloadTicks; `fire` is blocked until the reload settles
  // and out-of-reserve cannot reload. swapTicks is the ready delay after a `cycleWeapon` switch (fire is
  // blocked until ready). Melee is UNLIMITED — it carries only a swap delay, no magazine/reserve/reload.
  // Every timer is in fixed-clock ticks so reload/swap stay deterministic (V12). autoReloadWhenEmpty
  // optionally kicks a reload when a `fire` is attempted on an empty magazine (default off).

  /** When true, attempting to fire an empty magazine (with reserve available) auto-starts a reload. */
  autoReloadWhenEmpty: bool({
    owner: 'weapons',
    doc: 'When firing an empty magazine, automatically begin a reload if reserve remains. ON by default — a gun that silently stops with 48 rounds in reserve reads as broken; the player still gets the reload pause + can reload early with R.',
    default: true,
  }),

  // pistol ammo — a full magazine of 12 with a few spare mags in reserve; quick reload + quick swap.
  pistolMagazineSize: num({ owner: 'weapons', unit: 'count', doc: 'Pistol magazine capacity in rounds (T74). Bumped to 21 (mag) + 105 reserve = 126 total for easier testing.', default: 21, min: 1, max: 1000, integer: true }),
  pistolReserveAmmo: num({ owner: 'weapons', unit: 'count', doc: 'Pistol spare rounds held in reserve, fed into the magazine on reload (T74). 105 reserve + 21 mag = 126 total (testing).', default: 105, min: 0, max: 100_000, integer: true }),
  pistolReloadTicks: num({ owner: 'weapons', unit: 'ticks', doc: 'Fixed-clock ticks a pistol reload takes; fire is blocked until it settles (T74).', default: 45, min: 1, max: 6000, integer: true }),
  pistolSwapTicks: num({ owner: 'weapons', unit: 'ticks', doc: 'Fixed-clock ready delay after switching TO the pistol via cycleWeapon; fire is blocked until ready (T74).', default: 9, min: 0, max: 6000, integer: true }),

  // rifle ammo — large magazine, deep reserve, slower reload + slightly slower swap.
  rifleMagazineSize: num({ owner: 'weapons', unit: 'count', doc: 'Rifle magazine capacity in rounds (T74).', default: 30, min: 1, max: 1000, integer: true }),
  rifleReserveAmmo: num({ owner: 'weapons', unit: 'count', doc: 'Rifle spare rounds held in reserve (T74).', default: 120, min: 0, max: 100_000, integer: true }),
  rifleReloadTicks: num({ owner: 'weapons', unit: 'ticks', doc: 'Fixed-clock ticks a rifle reload takes (T74).', default: 60, min: 1, max: 6000, integer: true }),
  rifleSwapTicks: num({ owner: 'weapons', unit: 'ticks', doc: 'Fixed-clock ready delay after switching TO the rifle (T74).', default: 12, min: 0, max: 6000, integer: true }),

  // shotgun ammo — small shell magazine, modest reserve, long reload + slow swap.
  shotgunMagazineSize: num({ owner: 'weapons', unit: 'count', doc: 'Shotgun magazine capacity in SHELLS; one fire spends one shell = its pellet pattern (T74).', default: 6, min: 1, max: 1000, integer: true }),
  shotgunReserveAmmo: num({ owner: 'weapons', unit: 'count', doc: 'Shotgun spare shells held in reserve (T74).', default: 24, min: 0, max: 100_000, integer: true }),
  shotgunReloadTicks: num({ owner: 'weapons', unit: 'ticks', doc: 'Fixed-clock ticks a shotgun reload takes (T74).', default: 75, min: 1, max: 6000, integer: true }),
  shotgunSwapTicks: num({ owner: 'weapons', unit: 'ticks', doc: 'Fixed-clock ready delay after switching TO the shotgun (T74).', default: 15, min: 0, max: 6000, integer: true }),

  // ---- Per-class FIRE RATE (refire cooldown between shots, fixed-clock ticks; 0 = uncapped = click cadence) ----
  // The shotgun's interval is its FIRE+EJECT sample length (shotgun_shot_eject.wav ≈ 1.64 s) × tickHz(30) ≈ 49
  // ticks: the next shell can't chamber until the pump/eject finishes, so the cadence matches the sound. Pistol +
  // rifle stay 0 (semi-auto at click speed — unchanged). Baked as a deterministic config value (the headless sim
  // never reads the audio buffer — V1/V2); keep it in sync if the clip is replaced.
  pistolFireIntervalTicks: num({ owner: 'weapons', unit: 'ticks', doc: 'Min ticks between pistol shots (0 = uncapped / click cadence).', default: 0, min: 0, max: 600, integer: true }),
  rifleFireIntervalTicks: num({ owner: 'weapons', unit: 'ticks', doc: 'Min ticks between rifle shots (0 = uncapped).', default: 0, min: 0, max: 600, integer: true }),
  shotgunFireIntervalTicks: num({ owner: 'weapons', unit: 'ticks', doc: 'Min ticks between shotgun shots = the fire+eject sample length (≈1.64 s @ 30 tickHz). Pump cadence; keep in sync with shotgun_shot_eject.wav.', default: 49, min: 0, max: 600, integer: true }),

  // melee — unlimited; only a (short) swap ready delay applies.
  meleeClassSwapTicks: num({ owner: 'weapons', unit: 'ticks', doc: 'Fixed-clock ready delay after switching TO the melee weapon; melee has no ammo/reload (T74).', default: 6, min: 0, max: 6000, integer: true }),
});
