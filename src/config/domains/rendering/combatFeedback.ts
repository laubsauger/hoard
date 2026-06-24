// Config domain: rendering — combatFeedback sub-domain field definitions (split from rendering.ts; no behavior change).
// Plain spec objects (NOT a registered domain); spread into registerDomain('rendering', …) by ../rendering.ts.

import { num } from '../../spec';

export const combatFeedbackFields = {
  // ---- Combat feedback (B7 — muzzle flash / tracer / impact spark fed by VisualEvent + fire) ----
  combatSparkLifetimeSeconds: num({
    owner: 'rendering',
    unit: 'seconds',
    doc: 'Lifetime of a pooled impact-spark/blood marker spawned from a hit VisualEvent before it is recycled (B7).',
    default: 0.4,
    min: 0.05,
    max: 5,
  }),
  combatMuzzleFlashSeconds: num({
    owner: 'rendering',
    unit: 'seconds',
    doc: 'Duration of the muzzle-flash light + sprite pulse on player fire (B7).',
    default: 0.06,
    min: 0.01,
    max: 1,
  }),
  combatTracerSeconds: num({
    owner: 'rendering',
    unit: 'seconds',
    doc: 'Duration the shot tracer segment stays visible after firing (B7).',
    default: 0.08,
    min: 0.01,
    max: 1,
  }),
  combatMuzzleFlashIntensity: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Peak intensity of the muzzle-flash point light at full feedback before accessibility flash reduction (B7).',
    default: 6,
    min: 0,
    max: 50,
  }),
  combatTracerRangeMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Max length of the rendered shot tracer (the clean-miss length; a hit terminates at the struck-body travel — B15/V49).',
    default: 30,
    min: 1,
    max: 400,
  }),
  combatMuzzleOffsetMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Forward offset along the aim vector from the player body CENTRE to the weapon muzzle. The muzzle flash / tracer / impact ORIGINATE at playerPos + aim*offset (in front of the player), never at the body centre/back (B20-muzzle/V55, T78). Just beyond the body capsule radius so the beam exits in front of the avatar.',
    default: 0.7,
    min: 0,
    max: 3,
  }),
  // ---- Gore overhaul (B14/T71/V48): directional velocity spray from the struck region height + ground splat ----
  // No magic numbers — the region->height map, particle ballistics, splat size + lifetime are all typed here.
  combatGoreSprayParticleSizeMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Base edge length of ONE billboarded blood droplet quad. Energy only nudges it within sane bounds — never a meters-scale square (V48/B14).',
    default: 0.07,
    min: 0.01,
    max: 0.5,
    tiers: { 'desktop-high': 0.08, 'desktop-compat': 0.06, 'mobile-webgpu': 0.05 },
  }),
  combatGoreSprayVelocityMps: num({
    owner: 'rendering',
    unit: 'metersPerSecond',
    doc: 'Initial droplet speed launched ALONG the impact vector (hitReaction dirX/dirZ) before the gravity settle (V48).',
    default: 5,
    min: 0,
    max: 40,
  }),
  combatGoreSprayUpwardMps: num({
    owner: 'rendering',
    unit: 'metersPerSecond',
    doc: 'Initial upward component giving the spray its arc before gravity pulls droplets back down (V48).',
    default: 2.5,
    min: 0,
    max: 40,
  }),
  combatGoreSpraySpreadMps: num({
    owner: 'rendering',
    unit: 'metersPerSecond',
    doc: 'Peak lateral (perpendicular-to-impact) velocity spread per droplet — the fan of the spray (V48).',
    default: 2,
    min: 0,
    max: 40,
  }),
  combatGoreSprayGravityMps2: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Downward acceleration (m/s^2) applied over a droplet lifetime so the spray settles toward the ground (V48).',
    default: 9.81,
    min: 0,
    max: 40,
  }),
  combatGoreStainSizeMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Edge length of the persistent flattened ground-splat decal at the projected impact point (V48).',
    default: 0.45,
    min: 0.05,
    max: 5,
    tiers: { 'desktop-high': 0.55, 'mobile-webgpu': 0.35 },
  }),
  combatGoreStainLifetimeSeconds: num({
    owner: 'rendering',
    unit: 'seconds',
    doc: 'How long a ground splat stays before fading out — readable persistent stain, far longer than the airborne spark lifetime (V48).',
    default: 9,
    min: 0.5,
    max: 120,
    tiers: { 'desktop-high': 12, 'mobile-webgpu': 5 },
  }),
  combatGoreHeightHeadMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'World height above the body base at which head/neck hits emit blood (region->height map, V48).',
    default: 1.7,
    min: 0,
    max: 5,
  }),
  combatGoreHeightTorsoMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'World height above the body base for torso/arm hits — the mid band (region->height map, V48).',
    default: 1.1,
    min: 0,
    max: 5,
  }),
  combatGoreHeightLegMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'World height above the body base for leg hits — the low band (region->height map, V48).',
    default: 0.4,
    min: 0,
    max: 5,
  }),
  // Body SILHOUETTE half-widths (region->radius map): the radial distance from the body axis at which gore
  // splats sit at each anatomical band. A humanoid is NOT a fat cylinder — narrow at the head, widest at the
  // shoulders/torso, narrow again at the legs. Body-gore uses these (per region for a known hit, interpolated
  // by height for ambient player coating) so splats hug the rigged mesh instead of floating on a capsule.
  combatGoreRadiusHeadMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Body silhouette half-width at the HEAD band — gore splats on a head hit sit this far off the body axis.',
    default: 0.12,
    min: 0.02,
    max: 1,
  }),
  combatGoreRadiusTorsoMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Body silhouette half-width at the TORSO/shoulder band (the widest) — gore splats on a torso/arm hit sit this far off the body axis.',
    default: 0.24,
    min: 0.02,
    max: 1,
  }),
  combatGoreRadiusLegMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Body silhouette half-width at the LEG band — gore splats on a leg hit sit this far off the body axis.',
    default: 0.14,
    min: 0.02,
    max: 1,
  }),
};
