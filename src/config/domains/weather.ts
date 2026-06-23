// Config domain: weather. Owned by lane INT (T38 M1 vertical slice). Day/night cycle + weather profile
// drive the directional sun/moon angle and the atmospheric grading/fog severity the renderer applies.
// V4 — day length, sun geometry and per-profile severity are typed config, never literals in the engine.
// The renderer reads these; the authoritative sim only advances time-of-day from the FixedClock.

import { num, enumOf } from '../spec';
import { registerDomain } from '../registry';

/** Authored weather profiles the slice can cycle through (drives fog severity + grading id). */
export const WEATHER_PROFILES = ['clear', 'rain', 'fog', 'smoke'] as const;
export type WeatherProfile = (typeof WEATHER_PROFILES)[number];

export const weatherConfig = registerDomain('weather', {
  /** Real seconds for one full in-game day/night cycle (drives the sun angle from the sim clock). */
  dayLengthSeconds: num({
    owner: 'weather',
    unit: 'seconds',
    doc: 'Real seconds for a full day/night cycle. Sun/moon angle is derived from sim time modulo this.',
    default: 600,
    min: 10,
    max: 86_400,
  }),
  /** Time-of-day the slice starts at (0 = midnight, 0.5 = noon). */
  startTimeOfDay: num({
    owner: 'weather',
    unit: 'ratio',
    doc: 'Day fraction the scenario starts at (0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk).',
    default: 0.35,
    min: 0,
    max: 1,
  }),
  /** Peak elevation of the sun above the horizon at midday (degrees). */
  sunElevationMaxDegrees: num({
    owner: 'weather',
    unit: 'degrees',
    doc: 'Maximum elevation of the sun above the horizon at solar noon.',
    default: 62,
    min: 5,
    max: 90,
  }),
  /** Peak elevation of the moon above the horizon at solar midnight (degrees). */
  moonElevationMaxDegrees: num({
    owner: 'weather',
    unit: 'degrees',
    doc: 'Maximum elevation of the moon above the horizon at solar midnight.',
    default: 48,
    min: 5,
    max: 90,
  }),
  /** Compass azimuth the key light tracks along (diagonal to match the tactical camera, V21). */
  sunAzimuthDegrees: num({
    owner: 'weather',
    unit: 'degrees',
    doc: 'Azimuth (compass) the sun/moon arc is anchored to. Offset ~90° from the camera yaw (45°) so the key rakes ACROSS the near-ortho view and shadows read, instead of casting along the view axis where they hide behind objects (B13).',
    default: 160,
    min: 0,
    max: 360,
  }),
  /** Weather severity 0..1 feeding fog extinction + grading for each profile. */
  severityClear: num({ owner: 'weather', unit: 'ratio', doc: 'Atmospheric severity for the clear profile.', default: 0.04, min: 0, max: 1 }),
  severityRain: num({ owner: 'weather', unit: 'ratio', doc: 'Atmospheric severity for the rain profile.', default: 0.45, min: 0, max: 1 }),
  severityFog: num({ owner: 'weather', unit: 'ratio', doc: 'Atmospheric severity for the fog profile.', default: 0.8, min: 0, max: 1 }),
  severitySmoke: num({ owner: 'weather', unit: 'ratio', doc: 'Atmospheric severity for the smoke profile.', default: 0.65, min: 0, max: 1 }),
  /** Weather profile the slice boots into. */
  defaultProfile: enumOf({
    owner: 'weather',
    doc: 'Weather profile active at scenario start.',
    values: WEATHER_PROFILES,
    default: 'clear',
  }),
});

/** Resolved severity (0..1) for a profile, used by fog extinction + grading selection. */
export function weatherSeverity(
  resolved: { severityClear: number; severityRain: number; severityFog: number; severitySmoke: number },
  profile: WeatherProfile,
): number {
  switch (profile) {
    case 'clear': return resolved.severityClear;
    case 'rain': return resolved.severityRain;
    case 'fog': return resolved.severityFog;
    case 'smoke': return resolved.severitySmoke;
  }
}
