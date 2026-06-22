// Config domain: shadows. Owned by lane R (render). Self-registers on import (copies time.ts pattern).
// T29 / V8 / V22 — budgeted shadow cascades; casting prioritized by screen contribution / tier /
// distance / threat. V22 #2 — shadow distance/res + secondary casters scale down EARLY under pressure.
// V4 — every tunable typed with unit/owner/default/range/tier; invalid content throws at registration.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const shadowsConfig = registerDomain('shadows', {
  // ---- Directional cascade setup ----
  cascadeCount: num({
    owner: 'shadows',
    unit: 'count',
    doc: 'Number of shadow cascades for the directional key light.',
    default: 3,
    min: 1,
    max: 4,
    integer: true,
    tiers: { 'desktop-high': 4, 'desktop-medium': 3, 'desktop-compat': 2, 'mobile-webgpu': 1 },
  }),
  cascadeSplitLambda: num({
    owner: 'shadows',
    unit: 'ratio',
    doc: 'Blend between uniform (0) and logarithmic (1) cascade split distribution.',
    default: 0.6,
    min: 0,
    max: 1,
  }),
  shadowMapResolution: num({
    owner: 'shadows',
    unit: 'pixels',
    doc: 'Per-cascade shadow map edge resolution (V22 #2 scales this down under pressure).',
    default: 2048,
    min: 256,
    max: 8192,
    integer: true,
    tiers: { 'desktop-high': 4096, 'desktop-medium': 2048, 'desktop-compat': 1024, 'mobile-webgpu': 512 },
  }),
  shadowMaxDistanceMeters: num({
    owner: 'shadows',
    unit: 'meters',
    doc: 'Maximum world distance receiving directional shadows (V22 #2 shadow distance).',
    default: 120,
    min: 10,
    max: 1000,
    tiers: { 'desktop-high': 200, 'desktop-medium': 120, 'desktop-compat': 80, 'mobile-webgpu': 40 },
  }),

  // ---- Local/secondary caster budget (V22 #2 "secondary casters") ----
  localCasterBudget: num({
    owner: 'shadows',
    unit: 'count',
    doc: 'Max dynamic local lights allowed to cast shadows this frame (priority-ordered).',
    default: 6,
    min: 0,
    max: 64,
    integer: true,
    tiers: { 'desktop-high': 12, 'desktop-medium': 6, 'desktop-compat': 3, 'mobile-webgpu': 1 },
  }),

  // ---- Caster priority weights: score = sum(weight_i * normalized_factor_i) ----
  priorityScreenWeight: num({
    owner: 'shadows',
    unit: 'ratio',
    doc: 'Weight of on-screen contribution (projected size) in shadow-caster priority score.',
    default: 1,
    min: 0,
    max: 10,
  }),
  priorityDistanceWeight: num({
    owner: 'shadows',
    unit: 'ratio',
    doc: 'Weight of camera proximity (nearer = higher) in shadow-caster priority score.',
    default: 0.6,
    min: 0,
    max: 10,
  }),
  priorityThreatWeight: num({
    owner: 'shadows',
    unit: 'ratio',
    doc: 'Weight of gameplay threat (active attacker) in shadow-caster priority score.',
    default: 0.8,
    min: 0,
    max: 10,
  }),
  priorityTierWeight: num({
    owner: 'shadows',
    unit: 'ratio',
    doc: 'Weight of render-tier importance (hero highest) in shadow-caster priority score.',
    default: 0.5,
    min: 0,
    max: 10,
  }),
});
