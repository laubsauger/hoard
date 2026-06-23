// Config domain: combat. Owned by lane S (forward-pulled subset for GATE-0 / T41; full T16 later).
// V4 — resolution tunables + the GATE-0 horde-vs-player proof sizing are typed, never literals.
// V16 — damage resolves vs a named anatomical region + armor + penetration; head fatal by default.

import { bool, num } from '../spec';
import { registerDomain } from '../registry';

export const combatConfig = registerDomain('combat', {
  /** Within this distance of the shared-flow target a horde member STOPS steering (arrival) so it settles at
   *  the ring instead of piling into the target + jittering against the separation pass (V19/V35). */
  hordeArriveRadiusMeters: num({
    owner: 'combat',
    unit: 'meters',
    doc: 'Distance from the flow-field target at which a horde member stops steering (arrival ring).',
    default: 1.1,
    min: 0.3,
    max: 8,
  }),
  /** Default zombie health for the test-block population (T16/T17 archetypes refine this later). */
  zombieBaseHealth: num({
    owner: 'combat',
    unit: 'count',
    doc: 'Default zombie health for the GATE-0 test population.',
    default: 100,
    min: 1,
    max: 10_000,
  }),
  /** Flat damage subtracted before health loss (reduced by firearm penetration). */
  zombieBaseArmor: num({
    owner: 'combat',
    unit: 'count',
    doc: 'Default flat zombie armor (damage reduction) before penetration is applied.',
    default: 10,
    min: 0,
    max: 1000,
  }),
  /** Effective damage at/above which a severable region (limb/head) is flagged severed (V17). */
  severDamageThreshold: num({
    owner: 'combat',
    unit: 'count',
    doc: 'Effective damage on a severable region at/above which it is flagged severed.',
    default: 25,
    min: 1,
    max: 10_000,
  }),
  /** Head/neck destruction is fatal unless an archetype overrides (V17). */
  headFatalEnabled: bool({
    owner: 'combat',
    doc: 'Whether a resolved head/neck hit is fatal by default (head-kill rule, V17).',
    default: true,
  }),
  /** Ticks after taking damage during which a zombie is force-promoted to hero fidelity (V13). */
  recentDamageWindowTicks: num({
    owner: 'combat',
    unit: 'ticks',
    doc: 'Ticks a damaged zombie counts as recently-damaged for mandatory tier promotion.',
    default: 30,
    min: 0,
    max: 600,
    integer: true,
  }),
  /** Horde locomotion speed toward the shared flow-field target (world meters per second). */
  hordeMoveSpeed: num({
    owner: 'combat',
    unit: 'metersPerSecond',
    doc: 'Horde locomotion speed in world meters per simulation second (steering integrate step).',
    default: 1.4,
    min: 0.1,
    max: 12,
  }),
  /** Weight of the shared flow direction vs local separation when steering (1 = pure flow). */
  steerFlowWeight: num({
    owner: 'combat',
    unit: 'ratio',
    doc: 'Blend of shared flow-field direction vs neighbour separation in local steering (V15/V19).',
    default: 0.85,
    min: 0,
    max: 1,
  }),
  /** Separation radius pushing crowd members apart during steering (V19). */
  steerSeparationMeters: num({
    owner: 'combat',
    unit: 'meters',
    doc: 'Neighbour separation radius used by local steering to spread the crowd (V19).',
    default: 0.8,
    min: 0.1,
    max: 8,
  }),
  /** Available perf budget fed to the tier policy each frame (1 = full; lowers suppress promotions). */
  perfBudget: num({
    owner: 'combat',
    unit: 'ratio',
    doc: 'Available perf budget supplied to the tier manager (V13/V22). 1 = unconstrained.',
    default: 1,
    min: 0,
    max: 1,
  }),
  /** GATE-0 proof: number of zombies spawned in the test block (must be >= 500 to satisfy T41). */
  gateZeroZombieCount: num({
    owner: 'combat',
    unit: 'count',
    doc: 'Zombie population spawned for the GATE-0 vertical-proof test block (T41 requires >= 500).',
    default: 500,
    min: 1,
    max: 200_000,
    integer: true,
  }),
  /** GATE-0 proof: half-extent of the square spawn area for the horde in room A (meters). */
  gateZeroSpawnRadiusMeters: num({
    owner: 'combat',
    unit: 'meters',
    doc: 'Half-extent of the square area over which the GATE-0 horde is scattered at spawn.',
    default: 14,
    min: 1,
    max: 200,
  }),
  /** No zombie spawns within this radius of the player start — a safe bubble so one never materializes
   *  right next to the player at game start (a sampled scatter point inside it is rejected + resampled). */
  playerSafeSpawnMeters: num({
    owner: 'combat',
    unit: 'meters',
    doc: 'Minimum distance a spawned zombie must be from the player (safe bubble at start).',
    default: 8,
    min: 0,
    max: 100,
  }),

  // ---- T16 full pipeline: player melee attack-volume windows (V16) ----
  /** Ticks the player melee damage volume stays OPEN (only window in which melee damage applies, V16). */
  meleeActiveWindowTicks: num({
    owner: 'combat',
    unit: 'ticks',
    doc: 'Ticks the player melee attack volume is active — the only window damage applies (V16).',
    default: 4,
    min: 1,
    max: 120,
    integer: true,
  }),
  /** Wind-up ticks before the melee attack volume opens (no damage during wind-up). */
  meleeWindupTicks: num({
    owner: 'combat',
    unit: 'ticks',
    doc: 'Ticks of swing wind-up before the melee attack volume opens (no damage yet).',
    default: 3,
    min: 0,
    max: 120,
    integer: true,
  }),
  /** Recovery ticks after the melee window closes before another swing may start. */
  meleeRecoverTicks: num({
    owner: 'combat',
    unit: 'ticks',
    doc: 'Recovery ticks after the melee window closes before another swing can begin.',
    default: 5,
    min: 0,
    max: 240,
    integer: true,
  }),
  /** Whether a target struck with detailed anatomy is force-promoted to hero fidelity (V13/V16). */
  promoteOnDetailedHit: bool({
    owner: 'combat',
    doc: 'Promote a struck target to hero fidelity when detailed anatomy/anim is required (V13/V16).',
    default: true,
  }),
  /** Fraction of the nav cell size used as the march step when testing structure occlusion of a
   *  firearm ray (V53/B20). Must be <= 1 so a one-cell-thick wall is never stepped over. */
  projectileOcclusionStepRatio: num({
    owner: 'combat',
    unit: 'ratio',
    doc: 'Fraction of nav cell size used as the march step when testing structure occlusion of a firearm ray (<=1 so no cell is skipped). V53/B20.',
    default: 0.5,
    min: 0.05,
    max: 1,
  }),
  /** Damage multiplier applied when the target posture is downed/crawling (exposed/limited, V16). */
  postureDownDamageMultiplier: num({
    owner: 'combat',
    unit: 'ratio',
    doc: 'Damage multiplier when the target is downed/crawling (posture term in hit resolution, V16).',
    default: 1.25,
    min: 0.1,
    max: 10,
  }),

  // ---- Bug B: a standing-aim shot passes OVER floored bodies (height gate in the hit pipeline) ----
  /** Height (m) a normal standing-aim shot travels at. The firearm ray is resolved in the xz plane, so the
   *  projectile holds this flat height along its whole travel. A body whose vertical extent (top) is BELOW
   *  this is passed over — the shot flies above a corpse / prone / crawling body lying on the floor. */
  shotProjectileHeightMeters: num({
    owner: 'combat',
    unit: 'meters',
    doc: 'Flat height a standing-aim firearm shot travels at; a body whose top is below this is passed over (Bug B).',
    default: 1.2,
    min: 0.05,
    max: 5,
  }),
  /** Vertical extent (top, m) of an upright/standing body — its head clears the projectile height so a
   *  standing zombie is struck by a normal shot. */
  standingBodyHeightMeters: num({
    owner: 'combat',
    unit: 'meters',
    doc: 'Top height of a standing body; at/above shotProjectileHeightMeters so a standing target is hit (Bug B).',
    default: 1.8,
    min: 0.1,
    max: 5,
  }),
  /** Vertical extent (top, m) of a body lying on the floor — a corpse, or a prone/downed/crawling LIVE
   *  zombie. Below shotProjectileHeightMeters so a standing-aim shot flies over it instead of striking it. */
  flooredBodyHeightMeters: num({
    owner: 'combat',
    unit: 'meters',
    doc: 'Top height of a floored (corpse / prone / crawling) body; below shotProjectileHeightMeters so a standing shot passes over (Bug B).',
    default: 0.5,
    min: 0.05,
    max: 3,
  }),

  // ---- T17 dismemberment: detached-part pooling + missing-limb consequences (V17) ----
  /** Pool capacity for active detached-part handles before they must settle to props (V17/V18). */
  detachedPartPoolCapacity: num({
    owner: 'combat',
    unit: 'count',
    doc: 'Maximum simultaneously-active detached-part handles in the pool (V17/V18).',
    default: 256,
    min: 1,
    max: 100_000,
    integer: true,
  }),
  /** Ticks a detached part stays "active" (physics-ish) before settling to a cheap static prop (V17/V18). */
  detachedPartSettleTicks: num({
    owner: 'combat',
    unit: 'ticks',
    doc: 'Ticks a detached part is active before it settles to a cheap static prop (V17/V18).',
    default: 90,
    min: 1,
    max: 3600,
    integer: true,
  }),
  /** Per-missing-arm locomotion-speed penalty fraction (balance consequence, V17). */
  armLossLocomotionPenalty: num({
    owner: 'combat',
    unit: 'ratio',
    doc: 'Fraction of locomotion speed lost per missing arm (balance consequence, V17).',
    default: 0.1,
    min: 0,
    max: 1,
  }),
  /** Per-missing-leg locomotion-speed penalty fraction (V17). */
  legLossLocomotionPenalty: num({
    owner: 'combat',
    unit: 'ratio',
    doc: 'Fraction of locomotion speed lost per missing leg (V17).',
    default: 0.45,
    min: 0,
    max: 1,
  }),
  /** Per-missing-arm threat reduction fraction (reach/attack consequence, V17). */
  armLossThreatPenalty: num({
    owner: 'combat',
    unit: 'ratio',
    doc: 'Fraction of threat lost per missing arm (reduced reach/attack, V17).',
    default: 0.35,
    min: 0,
    max: 1,
  }),
  /** Leg-loss count at/above which a zombie can no longer walk and must crawl (posture change, V17). */
  legsLostToCrawl: num({
    owner: 'combat',
    unit: 'count',
    doc: 'Number of legs lost at/above which the zombie transitions to a crawl posture (V17).',
    default: 2,
    min: 1,
    max: 2,
    integer: true,
  }),

  // ---- T20 horde group action: structural pressure on barricades/doors (V19) ----
  /** Pressure one member contributes per tick while pressing a barricade/door (V19). */
  barricadePressurePerMemberPerTick: num({
    owner: 'combat',
    unit: 'ratio',
    doc: 'Pressure one crowd member adds per tick while pressing a barricade/door (V19).',
    default: 1,
    min: 0,
    max: 1000,
  }),
  /** Accumulated pressure at/above which one structural-damage increment is released (V19). */
  barricadePressureThreshold: num({
    owner: 'combat',
    unit: 'count',
    doc: 'Accumulated crowd pressure at/above which a structural-damage increment is applied (V19).',
    default: 40,
    min: 1,
    max: 100_000,
  }),
  /** Structural damage applied each time the pressure threshold is crossed (V19). */
  barricadeDamagePerThreshold: num({
    owner: 'combat',
    unit: 'count',
    doc: 'Structural damage applied to the barricade each time accumulated pressure is released (V19).',
    default: 10,
    min: 0.1,
    max: 100_000,
  }),

  // ---- T73 per-weapon ballistics: per-body penetration resistance (V50) ----
  /** Penetration budget one body consumes when a shot passes through it (V50). With the pistol's
   *  default 1-budget this stops the shot at the FIRST body; a rifle's larger budget pierces several. */
  bodyPenetrationResistance: num({
    owner: 'combat',
    unit: 'count',
    doc: 'Stopping-power budget consumed per body a shot passes through; exhausted budget stops the shot (V50).',
    default: 1,
    min: 0.01,
    max: 1000,
  }),

  // ---- T57 lethality + reactions: non-head hits wound/stagger, not instakill (V16/V17) ----
  /** Effective damage at/above which a non-lethal, non-head hit knocks the body into a brief stagger
   *  (slowed/interrupted) instead of just chipping health (V16/V17 wound reaction). */
  staggerDamageThreshold: num({
    owner: 'combat',
    unit: 'count',
    doc: 'Effective damage on a surviving (non-head) hit at/above which the body enters a brief stagger (V16/V17).',
    default: 30,
    min: 0.1,
    max: 100_000,
  }),
  /** Duration of the brief stagger state a wounding hit applies (drives the SoA stateTimer in seconds,
   *  consumed by behaviour to slow/interrupt the staggered body) (V16/V17). */
  staggerDurationSeconds: num({
    owner: 'combat',
    unit: 'seconds',
    doc: 'Seconds a wounded body stays in the stagger state (slowed/interrupted), written to the SoA stateTimer (V16/V17).',
    default: 0.6,
    min: 0.05,
    max: 30,
  }),
});
