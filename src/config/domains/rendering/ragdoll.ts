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
    doc: 'Fraction of a body’s linear velocity bled per second (air drag) — keeps the fall from oscillating forever (T134).',
    default: 1.1,
    min: 0,
    max: 8,
  }),
  ragdollAngularDamping: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Fraction of a body’s ANGULAR velocity bled per second — bleeds spin so the body settles instead of tumbling forever (T134).',
    default: 2.5,
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
    doc: 'Coulomb friction coefficient at a ground capsule contact (0 = frictionless, 1 = high grip) — stops the corpse sliding (T134).',
    default: 1.3,
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
    doc: 'force → initial linear SPEED (m/s) of the upper body (chest+head) along the killing shot — scales the knockback (T134).',
    default: 0.42,
    min: 0,
    max: 4,
  }),
  ragdollTorqueScale: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'force → initial tip-over ANGULAR speed (rad/s) of the chest about the horizontal axis ⟂ the shot — the body pitches over (T134).',
    default: 0.18,
    min: 0,
    max: 4,
  }),
  ragdollSettleEnergyThreshold: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Total kinetic proxy Σ(|v|²+|ω|²) over all bodies below which the ragdoll is declared SETTLED and stops integrating (T134).',
    default: 0.05,
    min: 0,
    max: 5,
  }),
  ragdollJointConeRadians: num({
    owner: 'rendering',
    unit: 'radians',
    doc: 'Loose cone/twist limit: max deviation (rad) of a joint’s relative orientation from its rest pose — keeps elbows/knees/neck from hyperextending through, but stays floppy (T134).',
    default: 1.5,
    min: 0.05,
    max: 3.1,
  }),
  ragdollGroundRadiusMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Collision radius of every body capsule end-sphere against the ground plane — the settled body rests this far above the surface, giving the prone trunk real thickness (T134).',
    default: 0.11,
    min: 0.01,
    max: 0.5,
  }),
  ragdollCapsuleRadiusMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Capsule radius used for each body’s mass + diagonal inertia (its thickness for tumbling) — fatter = more resistance to spin (T134).',
    default: 0.12,
    min: 0.02,
    max: 0.5,
  }),
};
