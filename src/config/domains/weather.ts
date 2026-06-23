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

  // --- Precipitation visuals (RENDER lane WeatherView). Additive: these drive the instanced rain streaks
  //     ONLY; fog density + colour grade stay owned by lighting/blockScene (untouched). ---

  /** Per-profile precipitation target intensity 0..1 the WeatherView ramps toward (count + opacity of rain).
   *  clear/fog are 0 — fog gets its atmosphere from the existing volumetric fog, never a duplicated layer. */
  precipIntensityClear: num({ owner: 'weather', unit: 'ratio', doc: 'Rain intensity target for the clear profile (gated off).', default: 0, min: 0, max: 1 }),
  precipIntensityRain: num({ owner: 'weather', unit: 'ratio', doc: 'Rain intensity target for the rain profile (full downpour).', default: 1, min: 0, max: 1 }),
  precipIntensityFog: num({ owner: 'weather', unit: 'ratio', doc: 'Rain intensity target for the fog profile (none — fog reads via the existing fog).', default: 0, min: 0, max: 1 }),
  precipIntensitySmoke: num({ owner: 'weather', unit: 'ratio', doc: 'Rain intensity target for the smoke profile (light drizzle through the haze).', default: 0.4, min: 0, max: 1 }),

  /** How fast precipitation intensity glides toward its profile target (per second) so a weather change
   *  never pops rain in/out — it fades up/down smoothly. */
  precipRampPerSecond: num({ owner: 'weather', unit: 'ratio', doc: 'Precipitation intensity ramp rate toward the active profile target, in units of intensity per second.', default: 1.5, min: 0.1, max: 10 }),

  /** Hard cap on the rain-streak instance pool. Drops recycle to the top, so a fixed pool covers the view. */
  rainPoolSize: num({ owner: 'weather', unit: 'count', doc: 'Maximum rain-streak instances (pool cap, recycled top-to-bottom). Lighter tiers thin the pool.', default: 1400, min: 0, max: 20_000, integer: true, tiers: { 'desktop-compat': 900, 'mobile-webgpu': 500 } }),
  /** Horizontal half-extent of the rain volume that FOLLOWS the camera/player (box is 2x this on each axis). */
  rainAreaMeters: num({ owner: 'weather', unit: 'meters', doc: 'Half-width of the rain volume centred on the camera/player; drops wrap within this box so the view is always covered.', default: 26, min: 1, max: 200 }),
  /** Vertical span of the rain volume — a drop recycles to (groundY + this) once it falls past the ground. */
  rainFallHeightMeters: num({ owner: 'weather', unit: 'meters', doc: 'Vertical height of the rain volume; a drop that passes the ground recycles to groundY + this.', default: 22, min: 1, max: 200 }),
  /** World Y the rain falls toward; a drop is recycled to the top once it drops below this. */
  rainGroundYMeters: num({ owner: 'weather', unit: 'meters', doc: 'Ground level the rain falls toward (recycle plane).', default: 0, min: -50, max: 50 }),
  /** Fall speed of the rain streaks. */
  rainSpeedMps: num({ owner: 'weather', unit: 'metersPerSecond', doc: 'Downward fall speed of the rain streaks.', default: 26, min: 1, max: 200 }),
  /** Length of a vertical rain streak (the elongated falling segment). */
  rainStreakLengthMeters: num({ owner: 'weather', unit: 'meters', doc: 'Length of a single vertical rain streak.', default: 0.9, min: 0.01, max: 10 }),
  /** Width of a rain streak (thin). */
  rainStreakWidthMeters: num({ owner: 'weather', unit: 'meters', doc: 'Width of a single rain streak (thin vertical bar).', default: 0.018, min: 0.001, max: 1 }),
  /** Wind slant: horizontal drift as a fraction of fall speed (also leans the streak). */
  rainWindSlant: num({ owner: 'weather', unit: 'ratio', doc: 'Horizontal wind drift of the rain as a fraction of fall speed (slants the streaks).', default: 0.18, min: -2, max: 2 }),
  /** Peak opacity of a rain streak at full intensity. */
  rainOpacity: num({ owner: 'weather', unit: 'ratio', doc: 'Peak opacity of a rain streak at full precipitation intensity.', default: 0.32, min: 0, max: 1 }),
  /** Cool grey-blue streak tint (linear RGB). */
  rainColorR: num({ owner: 'weather', unit: 'ratio', doc: 'Rain streak tint red (linear).', default: 0.62, min: 0, max: 1 }),
  rainColorG: num({ owner: 'weather', unit: 'ratio', doc: 'Rain streak tint green (linear).', default: 0.70, min: 0, max: 1 }),
  rainColorB: num({ owner: 'weather', unit: 'ratio', doc: 'Rain streak tint blue (linear).', default: 0.82, min: 0, max: 1 }),
});

/** Resolved per-profile precipitation intensity target (0..1) the WeatherView ramps toward. clear/fog gate
 *  precipitation off (0); rain is a full downpour, smoke a lighter drizzle through the existing haze. */
export function precipTarget(
  resolved: {
    precipIntensityClear: number;
    precipIntensityRain: number;
    precipIntensityFog: number;
    precipIntensitySmoke: number;
  },
  profile: WeatherProfile,
): number {
  switch (profile) {
    case 'clear': return resolved.precipIntensityClear;
    case 'rain': return resolved.precipIntensityRain;
    case 'fog': return resolved.precipIntensityFog;
    case 'smoke': return resolved.precipIntensitySmoke;
  }
}

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
