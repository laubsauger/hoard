// Config domain: rendering — ragdoll sub-domain field definitions (T134 / V2 / V4).
// Plain spec objects (NOT a registered domain); spread into registerDomain('rendering', …) by ../rendering.ts.
// Tunables for the PER-LIMB death ragdoll (src/render/corpse/ragdoll.ts) — a render-only VIEW effect (V2). NO
// magic numbers in the sim: every constant the integrator reads is a typed field here, resolved per tier (V4).

import { num } from '../../spec';

export const ragdollFields = {
  ragdollGravityMetersPerSec2: num({
    owner: 'rendering',
    unit: 'metersPerSecond', // m/s² (closest available unit); a touch heavier than 9.8 for game-feel.
    doc: 'Downward acceleration on the death-ragdoll particles — a touch heavier than real gravity so a body drops with weight (T134).',
    default: 14,
    min: 1,
    max: 40,
  }),
  ragdollLinearDamping: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Fraction of a particle’s linear velocity bled per second (air drag) — keeps the fall from oscillating forever (T134).',
    default: 0.6,
    min: 0,
    max: 8,
  }),
  ragdollAngularDamping: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Extra velocity fraction bled per second while a particle is in GROUND CONTACT — settles the body instead of letting it skid/jitter (T134).',
    default: 4,
    min: 0,
    max: 30,
  }),
  ragdollGroundRestitution: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Vertical bounce kept on a ground hit (0 = dead stop, 1 = elastic). Small so the body sags and settles, not trampolines (T134).',
    default: 0.12,
    min: 0,
    max: 0.9,
  }),
  ragdollGroundFriction: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Horizontal velocity fraction killed per ground-contact step (0 = frictionless, 1 = instant stop) — stops the corpse sliding (T134).',
    default: 0.5,
    min: 0,
    max: 1,
  }),
  ragdollConstraintIterations: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Distance-constraint relaxation passes per substep — higher = stiffer bones / less stretch (T134).',
    default: 8,
    min: 1,
    max: 32,
    integer: true,
    tiers: { 'desktop-high': 10, 'desktop-compat': 6, 'mobile-webgpu': 4 },
  }),
  ragdollSubsteps: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Verlet substeps per stepped frame — higher = more stable at large dt, costs CPU (T134).',
    default: 3,
    min: 1,
    max: 12,
    integer: true,
    tiers: { 'desktop-high': 4, 'desktop-compat': 2, 'mobile-webgpu': 2 },
  }),
  ragdollImpulseScale: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'force → initial impulse SPEED (m/s) of the upper body along the killing shot — scales the knockback (T134).',
    default: 0.06,
    min: 0,
    max: 2,
  }),
  ragdollTorqueScale: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Extra forward launch speed added per unit of normalized particle HEIGHT — the tip-over torque proxy (head leads, feet lag) (T134).',
    default: 2.5,
    min: 0,
    max: 12,
  }),
  ragdollSettleEnergyThreshold: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Per-substep summed squared-displacement (m²) below which the ragdoll is declared SETTLED and stops integrating (T134).',
    default: 0.0000004,
    min: 0,
    max: 1,
  }),
  ragdollJointConeRadians: num({
    owner: 'rendering',
    unit: 'radians',
    doc: 'Tightest included angle allowed at a cone-limited joint (elbow/knee/neck) — prevents hyper-fold into spaghetti (T134).',
    default: 0.6,
    min: 0.05,
    max: 3,
  }),
  ragdollGroundRadiusMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Collision radius of every joint particle against the ground plane — the settled body rests this far above the surface (T134).',
    default: 0.09,
    min: 0.01,
    max: 0.5,
  }),
};
