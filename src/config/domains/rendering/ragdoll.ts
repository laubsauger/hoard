// Config domain: rendering — ragdoll sub-domain field definitions (T134 / V2 / V4).
// Plain spec objects (NOT a registered domain); spread into registerDomain('rendering', …) by ../rendering.ts.
// Tunables for the PER-LIMB death ragdoll (src/render/corpse/ragdoll.ts) — a render-only VIEW effect (V2). NO
// magic numbers in the sim: every constant the integrator reads is a typed field here, resolved per tier (V4).
// V2 — the sim is now an ORIENTED-RIGID-BODY ragdoll (a quaternion per bone-body, capsule colliders, point-to-
// point joints, contact impulses) — these fields drive that integrator.

import { num } from '../../spec';

export const ragdollFields = {
  ragdollGravityMetersPerSec2: num({
    owner: 'rendering',
    unit: 'metersPerSecond', // m/s² (closest available unit); a touch heavier than 9.8 for game-feel.
    doc: 'Downward acceleration on the death-ragdoll bodies — a touch heavier than real gravity so a body drops with weight (T134).',
    default: 16,
    min: 1,
    max: 40,
  }),
  // ---- DECOUPLED DAMPING (V4). The fall is split into a WHOLE-BODY rigid motion (common COM translation + a common
  // tumble) and the NON-rigid residual (each body deviating from that rigid motion = limb flail). The common motion is
  // damped LIGHTLY so the knockback TRAVELS + the body tumbles; the residual is damped HARD so the limbs stay stiff and
  // never mangle. linearDamping = the light COM-translation drag; tumbleDamping = the light common-angular drag;
  // internalLinearDamping + angularDamping = the heavy residual (relative) drags. ----
  ragdollLinearDamping: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Fraction of the WHOLE-BODY COM TRANSLATION velocity bled per second — LIGHT so a shot’s knockback TRAVELS (the body slides/tumbles across the ground) instead of damping to a crumble in place (T134).',
    default: 0.35,
    min: 0,
    max: 8,
  }),
  ragdollInternalLinearDamping: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Fraction of each body’s RESIDUAL (non-rigid) linear velocity — its velocity relative to the whole-body rigid motion — bled per second. HEAVY so limbs don’t flail/mangle, while the common COM translation (linearDamping) stays free to travel (T134).',
    default: 6,
    min: 0,
    max: 40,
  }),
  ragdollAngularDamping: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Fraction of each body’s RESIDUAL angular velocity (its spin relative to the common whole-body tumble) bled per second — HEAVY so limbs stop spinning independently (stiff, no flail) while the common tumble (tumbleDamping) survives (T134).',
    default: 4.5,
    min: 0,
    max: 30,
  }),
  ragdollTumbleDamping: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Fraction of the COMMON whole-body tumble (the average angular velocity) bled per second — LIGHT so the corpse keeps rotating/tumbling as it travels after a hit instead of damping to a stop (T134).',
    default: 0.5,
    min: 0,
    max: 30,
  }),
  ragdollJointAngularDamping: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Per-joint fraction of the RELATIVE angular velocity between a joint’s two bodies removed each substep — the “stiffness like damping” that keeps elbows/knees/shoulders/hips from flailing into a mangle, while still letting limbs flop (T134).',
    default: 0.12,
    min: 0,
    max: 0.9,
  }),
  ragdollGroundRestitution: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Vertical bounce kept on a ground hit (0 = dead stop, 1 = elastic). Small so the body sags and settles, not trampolines (T134).',
    default: 0.03,
    min: 0,
    max: 0.9,
  }),
  ragdollGroundFriction: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Coulomb friction coefficient at a ground capsule contact (0 = frictionless) — LOW so the feet don’t glue + the body slides/tumbles forward on impact instead of folding in place (T134).',
    default: 0.85,
    min: 0,
    max: 2,
  }),
  ragdollConstraintIterations: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Joint (point-to-point + cone) solver iterations per substep — higher = stiffer joints / less stretch (T134).',
    default: 2,
    min: 1,
    max: 32,
    integer: true,
    tiers: { 'desktop-high': 2, 'desktop-compat': 2, 'mobile-webgpu': 1 },
  }),
  ragdollSubsteps: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Semi-implicit Euler substeps per stepped frame — higher = more stable at large dt, costs CPU (T134).',
    default: 10,
    min: 1,
    max: 24,
    integer: true,
    tiers: { 'desktop-high': 12, 'desktop-compat': 8, 'mobile-webgpu': 5 },
  }),
  ragdollImpulseScale: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'force → initial COM SPEED (m/s) of the WHOLE body along the killing shot — the travelling shove. Tuned so pistol (force 4) clearly topples + travels and shotgun (force 13) launches visibly harder (T134).',
    default: 0.5,
    min: 0,
    max: 8,
  }),
  ragdollTorqueScale: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'force → initial whole-body TIP-OVER angular speed (rad/s) about the horizontal axis ⟂ the shot — the corpse pitches over in the shot direction (a directional topple, not a vertical crumple) (T134).',
    default: 0.42,
    min: 0,
    max: 8,
  }),
  ragdollSettleEnergyThreshold: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Total kinetic proxy Σ(|v|²+|ω|²) over all bodies below which the ragdoll is declared SETTLED and stops integrating (T134).',
    default: 0.08,
    min: 0,
    max: 5,
  }),
  // ---- VOLUME: per-size-class capsule radii (m). The torso is FATTER than the limbs so the body rests with bulk
  // (not a flat towel) + the limbs stay outside the trunk. Used for both ground rest-height AND mass/inertia. ----
  ragdollTorsoRadiusMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Capsule radius of the TORSO bodies (pelvis, chest) — fattest, so the prone trunk reads as a body with bulk and resists folding (T134).',
    default: 0.17,
    min: 0.05,
    max: 0.5,
  }),
  ragdollHeadRadiusMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Capsule radius of the HEAD body — mid; also its COM is lifted by this so gravity lolls the head to the ground (T134).',
    default: 0.11,
    min: 0.03,
    max: 0.4,
  }),
  ragdollLimbRadiusMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Capsule radius of the LIMB bodies (arms, legs) — thin, so they read distinct from the bulky trunk (T134).',
    default: 0.075,
    min: 0.02,
    max: 0.3,
  }),
  // ---- ANATOMICAL ANGULAR LIMITS (rad, deviation from each joint’s rest orientation). Trunk near-rigid, neck
  // loose, hip/shoulder cone-limited, knee/elbow one-way hinges. NO magic numbers in the sim — resolved here. ----
  ragdollSpineLimitRadians: num({
    owner: 'rendering',
    unit: 'radians',
    doc: 'Spine (pelvis↔chest) swing+twist limit — VERY TIGHT so the trunk stays a stiff board (moves as one), never folds like a towel (T134).',
    default: 0.14,
    min: 0.02,
    max: 1.5,
  }),
  ragdollNeckLimitRadians: num({
    owner: 'rendering',
    unit: 'radians',
    doc: 'Neck (chest↔head) swing limit — LOOSE so the head lolls all the way to the ground instead of propping upright (T134).',
    default: 1.7,
    min: 0.1,
    max: 3.1,
  }),
  ragdollShoulderLimitRadians: num({
    owner: 'rendering',
    unit: 'radians',
    doc: 'Shoulder (chest↔upperArm) cone half-angle — wide arc so the arms flop naturally (T134).',
    default: 1.4,
    min: 0.1,
    max: 3.1,
  }),
  ragdollHipLimitRadians: num({
    owner: 'rendering',
    unit: 'radians',
    doc: 'Hip (pelvis↔thigh) cone half-angle — moderate arc so the legs splay but stay attached realistically (T134).',
    default: 1.1,
    min: 0.1,
    max: 3.1,
  }),
  ragdollHingeSwingLimitRadians: num({
    owner: 'rendering',
    unit: 'radians',
    doc: 'Off-hinge swing tolerance for the knee/elbow hinges — small so they bend PLANAR about one axis (T134).',
    default: 0.3,
    min: 0.02,
    max: 1.0,
  }),
  ragdollElbowMaxRadians: num({
    owner: 'rendering',
    unit: 'radians',
    doc: 'Elbow one-way fold range — folds up to this from straight, never hyperextends backward (T134).',
    default: 2.4,
    min: 0.5,
    max: 3.0,
  }),
  ragdollKneeMaxRadians: num({
    owner: 'rendering',
    unit: 'radians',
    doc: 'Knee one-way fold range — folds up to this from straight, never bends the wrong way (T134).',
    default: 2.4,
    min: 0.5,
    max: 3.0,
  }),
  ragdollTrunkStiffness: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Fraction of the pelvis↔chest relative angular velocity removed each substep so they co-rotate like a board — HIGH for the near-rigid TORSO that barely bends (T134).',
    default: 0.7,
    min: 0,
    max: 0.95,
  }),
  ragdollTrunkIterations: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'EXTRA positional solver iterations run on the trunk (spine) joint each substep so the torso stays rigid + the pelvis↔chest anchor barely separates under impact (T134).',
    default: 6,
    min: 0,
    max: 24,
    integer: true,
    tiers: { 'desktop-high': 6, 'desktop-compat': 4, 'mobile-webgpu': 2 },
  }),
  // ---- STABILITY CAPS / EXPLOSION BACKSTOP (V4). Clamp the PBD-recomputed velocities to a physical range; if a body
  // still goes non-finite or its speed blows past the explode threshold, reset it to rest on the ground (a correctness
  // guard against solver blow-ups, NOT a gameplay fallback). ----
  ragdollMaxLinearSpeed: num({
    owner: 'rendering',
    unit: 'metersPerSecond',
    doc: 'Hard cap (m/s) on each body’s recomputed linear speed per substep — a fast limb whip can spike Δx/h; keep it physical (T134).',
    default: 14,
    min: 1,
    max: 60,
  }),
  ragdollMaxAngularSpeed: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Hard cap (rad/s) on each body’s recomputed angular speed per substep (T134).',
    default: 22,
    min: 1,
    max: 80,
  }),
  ragdollExplodeSpeed: num({
    owner: 'rendering',
    unit: 'metersPerSecond',
    doc: 'If a body’s linear speed exceeds this (or any state goes non-finite) the solver is judged to have blown up and that body is reset to rest on the ground — a correctness backstop so a penetrating body never “freaks out” (T134).',
    default: 28,
    min: 2,
    max: 120,
  }),
};
