// Combat lane barrel — full T16 pipeline + T17 dismemberment + T18 weapons.

export {
  ANATOMY_REGIONS,
  regionBit,
  isSevered,
  isFatalRegion,
  isSeverable,
  damageClass,
  type DamageClass,
} from './anatomy';
export {
  CombatSystem,
  type CombatDeps,
  type ShotOrigin,
  type ShotResult,
  type AmmoStatus,
} from './hitPath';
export {
  buildWeaponRegistry,
  WEAPON_IDS,
  type WeaponClass,
  type WeaponId,
  type WeaponKind,
} from './weaponRegistry';
export {
  Posture,
  buildSegments,
  severedCount,
  limbConsequences,
  DetachedPartPool,
  type AnatomySegment,
  type ConsequenceConfig,
  type LimbConsequences,
  type DetachedPart,
} from './segments';
export {
  regionsForTier,
  tierExposes,
  needsDetail,
  coarsenRegion,
  regionFromGeometry,
} from './hitVolume';
export {
  MeleeSwing,
  type SwingPhase,
  type SwingConfig,
} from './attackWindow';
export {
  WeaponSystem,
  Magazine,
  type WeaponDeps,
  type FireOutcome,
  type MeleeOutcome,
} from './weapons';
