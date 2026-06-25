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
  ragdollLinearDamping: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Fraction of a body’s linear velocity bled per second (air drag) — low so a shot’s knockback TRAVELS instead of dying on the spot (T134).',
    default: 0.8,
    min: 0,
    max: 8,
  }),
  ragdollAngularDamping: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Fraction of a body’s ANGULAR velocity bled per second — bleeds spin so the body settles instead of tumbling forever (T134).',
    default: 2.1,
    min: 0,
    max: 30,
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
    doc: 'force → initial linear SPEED (m/s) of the WHOLE body along the killing shot — the travelling shove (corpse lands AHEAD of where it stood; bigger force → farther) (T134).',
    default: 0.25,
    min: 0,
    max: 4,
  }),
  ragdollTorqueScale: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'force → initial tip-over ANGULAR speed (rad/s) of the chest about the horizontal axis ⟂ the shot — the body pitches over (T134).',
    default: 0.28,
    min: 0,
    max: 4,
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
    doc: 'Spine (pelvis↔chest) swing+twist limit — TIGHT so the trunk stays a stiff board, not a towel fold (T134).',
    default: 0.3,
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
    doc: 'Fraction of the pelvis↔chest relative angular velocity removed each substep so they co-rotate like a board — the stiff TORSO (T134).',
    default: 0.35,
    min: 0,
    max: 0.9,
  }),
};
