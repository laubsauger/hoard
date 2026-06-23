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
  minAmbientIntensity: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Hard floor on ambient fill so a night spawn never crushes the scene to black (B6 viewable-night floor).',
    default: 0.12,
    min: 0,
    max: 2,
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
  fogVisibilityTransmittance: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Transmittance at which the scene has fully faded to fog colour — sets the analytic fog far plane (B5).',
    default: 0.12,
    min: 0.001,
    max: 0.99,
  }),
  fogFarMinMeters: num({
    owner: 'lighting',
    unit: 'meters',
    doc: 'Lower clamp on the fog far distance (heavy weather) so the far plane never collapses onto the player (B5).',
    default: 60,
    min: 5,
    max: 2000,
  }),
  fogFarMaxMeters: num({
    owner: 'lighting',
    unit: 'meters',
    doc: 'Upper clamp on the fog far distance (clear weather) so distant geometry still fades into atmosphere (B5).',
    default: 360,
    min: 10,
    max: 4000,
  }),
  fogNearRatio: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Fog near distance as a fraction of the fog far distance (linear fog onset).',
    default: 0.35,
    min: 0,
    max: 0.95,
  }),
  fogDistanceSmoothingPerSecond: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Per-second exponential approach rate for fog near/far toward their target — decouples fog from per-frame severity changes so the boundary never sweeps the screen as bands (B5).',
    default: 4,
    min: 0.1,
    max: 60,
  }),
  fogFloorLuminance: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Minimum luminance of the fog/background colour (lifts it off near-black so the scene reads against the far plane — B5).',
    default: 0.16,
    min: 0,
    max: 1,
  }),
  nightExposureBoostStops: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Extra exposure stops applied at full darkness (scene-brightness 0) so a night scene stays viewable after tone mapping (B6).',
    default: 1.5,
    min: 0,
    max: 6,
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
