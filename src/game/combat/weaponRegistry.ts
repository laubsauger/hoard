// T73 / V50 — per-weapon ballistics registry.
// Each weapon CLASS (pistol / rifle / shotgun / melee) is a typed ballistic model assembled from the
// weapons config (V4 — no literals): base damage, effective range, a penetration BUDGET (stopping
// power) consumed per body by its resistance, an angular spread, a per-meter distance damage falloff,
// a pellet count (>1 = shotgun cone) and an armor-penetration fraction. The CombatSystem holds the
// CURRENT class and `fire` resolves against it (a pistol stops at 1 body, a rifle pierces several,
// a shotgun fires multiple pellets in a spread — V50). This is pure DATA derived from config.

import type { ResolvedDomain } from '@/config/types';
import type { weaponsConfig } from '@/config/domains/weapons';

/** Resolution shape of one weapon class. Firearm = ray/pellet ballistics; melee = short directed strike. */
export type WeaponKind = 'firearm' | 'melee';

/** Stable identifier for an equippable weapon class. */
export type WeaponId = 'pistol' | 'rifle' | 'shotgun' | 'melee';

export const WEAPON_IDS: readonly WeaponId[] = ['pistol', 'rifle', 'shotgun', 'melee'];

/** A fully-resolved ballistic model for one weapon class (V50). */
export interface WeaponClass {
  readonly id: WeaponId;
  readonly kind: WeaponKind;
  /** Base damage per projectile, before anatomical-region multiplier, distance falloff and armor. */
  readonly damage: number;
  /** Maximum ray travel; candidates beyond this are not gathered (V16/V50). */
  readonly rangeMeters: number;
  /** Penetration budget consumed per body by its resistance; exhausted budget STOPS the shot (V50). */
  readonly stoppingPower: number;
  /** Full angular spread across the pellet pattern (degrees). */
  readonly spreadDegrees: number;
  /** Fraction of damage lost per meter of travel (distance falloff). */
  readonly damageFalloffPerMeter: number;
  /** Projectiles fired per shot (>1 = a spread cone, e.g. a shotgun). */
  readonly pellets: number;
  /** Fraction of the target's armor a hit ignores (penetration term in resolution). */
  readonly armorPenetration: number;
  // ---- T74 ammo / reload / swap ----
  /** Fixed-clock ready delay after switching TO this class via cycleWeapon; fire is blocked until ready. */
  readonly swapTicks: number;
  /** Magazine capacity in rounds (shells for a shotgun). Absent => unlimited ammo (melee). */
  readonly magazineSize?: number;
  /** Spare rounds fed into the magazine on reload. Absent => unlimited ammo (melee). */
  readonly reserveAmmo?: number;
  /** Fixed-clock ticks a reload takes; fire is blocked until it settles. Absent => no reload (melee). */
  readonly reloadTicks?: number;
}

type Weapons = ResolvedDomain<typeof weaponsConfig>;

/** Build the immutable registry of weapon classes from the resolved weapons config (V4/V50). */
export function buildWeaponRegistry(w: Weapons): Readonly<Record<WeaponId, WeaponClass>> {
  return Object.freeze({
    pistol: Object.freeze({
      id: 'pistol',
      kind: 'firearm',
      damage: w.pistolDamage,
      rangeMeters: w.pistolRangeMeters,
      stoppingPower: w.pistolStoppingPower,
      spreadDegrees: w.pistolSpreadDegrees,
      damageFalloffPerMeter: w.pistolDamageFalloffPerMeter,
      pellets: w.pistolPellets,
      armorPenetration: w.pistolArmorPenetration,
      swapTicks: w.pistolSwapTicks,
      magazineSize: w.pistolMagazineSize,
      reserveAmmo: w.pistolReserveAmmo,
      reloadTicks: w.pistolReloadTicks,
    }),
    rifle: Object.freeze({
      id: 'rifle',
      kind: 'firearm',
      damage: w.rifleDamage,
      rangeMeters: w.rifleRangeMeters,
      stoppingPower: w.rifleStoppingPower,
      spreadDegrees: w.rifleSpreadDegrees,
      damageFalloffPerMeter: w.rifleDamageFalloffPerMeter,
      pellets: w.riflePellets,
      armorPenetration: w.rifleArmorPenetration,
      swapTicks: w.rifleSwapTicks,
      magazineSize: w.rifleMagazineSize,
      reserveAmmo: w.rifleReserveAmmo,
      reloadTicks: w.rifleReloadTicks,
    }),
    shotgun: Object.freeze({
      id: 'shotgun',
      kind: 'firearm',
      damage: w.shotgunDamage,
      rangeMeters: w.shotgunRangeMeters,
      stoppingPower: w.shotgunStoppingPower,
      spreadDegrees: w.shotgunSpreadDegrees,
      damageFalloffPerMeter: w.shotgunDamageFalloffPerMeter,
      pellets: w.shotgunPellets,
      armorPenetration: w.shotgunArmorPenetration,
      swapTicks: w.shotgunSwapTicks,
      magazineSize: w.shotgunMagazineSize,
      reserveAmmo: w.shotgunReserveAmmo,
      reloadTicks: w.shotgunReloadTicks,
    }),
    melee: Object.freeze({
      id: 'melee',
      kind: 'melee',
      damage: w.meleeClassDamage,
      rangeMeters: w.meleeClassRangeMeters,
      stoppingPower: w.meleeClassStoppingPower,
      spreadDegrees: w.meleeClassSpreadDegrees,
      damageFalloffPerMeter: w.meleeClassDamageFalloffPerMeter,
      pellets: w.meleeClassPellets,
      armorPenetration: w.meleeClassArmorPenetration,
      swapTicks: w.meleeClassSwapTicks,
      // melee is UNLIMITED: no magazine / reserve / reload (T74).
    }),
  });
}
