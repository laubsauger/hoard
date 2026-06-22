// Config domain: lighting. Owned by lane R (render). Self-registers on import (copies time.ts pattern).
// T29 / V8 — directional sun/moon, dynamic local lights, contact+ambient AO near player, fog/weather
// extinction + interior exposure transitions. V4 — every tunable carries unit/owner/default/range/tier.
// V22 — dynamic local lights are an EARLY scaling victim (#5), so their budget is per-tier.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const lightingConfig = registerDomain('lighting', {
  // ---- Key directional light (sun by day / moon by night) ----
  sunIntensity: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Directional key-light intensity at midday (relative luminance multiplier).',
    default: 1,
    min: 0,
    max: 10,
  }),
  moonIntensity: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Directional key-light intensity at night (moonlight).',
    default: 0.15,
    min: 0,
    max: 10,
  }),
  ambientIntensity: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Baked/precomputed indirect ambient floor for static architecture.',
    default: 0.25,
    min: 0,
    max: 5,
  }),

  // ---- Dynamic local lights (flashlight/fire/alarm/vehicle) — V22 scaling step #5 ----
  localLightBudget: num({
    owner: 'lighting',
    unit: 'count',
    doc: 'Max simultaneously active dynamic local lights (scaled down under GPU pressure, V22 #5).',
    default: 16,
    min: 0,
    max: 256,
    integer: true,
    tiers: { 'desktop-high': 32, 'desktop-medium': 16, 'desktop-compat': 8, 'mobile-webgpu': 4 },
  }),

  // ---- Contact + ambient occlusion near the player ----
  contactAoRadiusMeters: num({
    owner: 'lighting',
    unit: 'meters',
    doc: 'World-space radius around the player within which contact/ambient occlusion is emphasized.',
    default: 6,
    min: 0.5,
    max: 50,
  }),
  ambientOcclusionStrength: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Strength of near-player ambient occlusion darkening (0 = off).',
    default: 0.6,
    min: 0,
    max: 1,
    tiers: { 'desktop-high': 0.7, 'desktop-compat': 0.4, 'mobile-webgpu': 0.3 },
  }),

  // ---- Atmospheric fog / weather extinction ----
  fogExtinctionPerMeter: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Base atmospheric extinction coefficient per world meter (clear weather).',
    default: 0.006,
    min: 0,
    max: 1,
  }),
  weatherExtinctionMultiplierMax: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Upper multiplier on fog extinction at maximum weather severity (rain/smoke/fog).',
    default: 6,
    min: 1,
    max: 50,
  }),

  // ---- Interior exposure transitions (eyes adapting going in/out of buildings) ----
  interiorExposureStops: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Exposure compensation (stops) applied when fully inside an enclosed interior.',
    default: 1.2,
    min: 0,
    max: 6,
  }),
  exposureTransitionSeconds: num({
    owner: 'lighting',
    unit: 'seconds',
    doc: 'Time to blend exposure when crossing the interior/exterior threshold.',
    default: 0.8,
    min: 0,
    max: 10,
  }),
});
