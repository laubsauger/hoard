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
    doc: 'Day fraction the scenario starts at (0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk). Starts MID-NIGHT (~01:12): the moon is near peak elevation, so the open street reads in cold moonlit silhouette while roof-shadowed interiors go near-black without the flashlight.',
    default: 0.05,
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

  // --- Per-profile atmosphere GRADING (lighting lane). Each weather has its OWN light vibe ON TOP of the
  //     severity-driven fog distance: a key/ambient intensity SCALE + a key/ambient/fog colour TINT. The
  //     LightingSystem eases (approach()) between profiles on a weather change so the vibe never snaps. Hex
  //     tints are authored sRGB (decoded by Three's setHex). V4: every value typed, never a literal in the engine.

  /** How fast the per-weather grade (key/ambient scale + tints + fog colour) eases toward the active profile,
   *  per second. Mirrors fogDistanceSmoothingPerSecond so a weather change EASES, never snaps. */
  gradeSmoothingPerSecond: num({ owner: 'weather', unit: 'ratio', doc: 'Per-second exponential approach rate for the per-weather light/fog grade toward the active profile (so a weather change eases, never snaps).', default: 2, min: 0.1, max: 60 }),
  /** Night dimming applied to the (daytime-authored) fog/atmosphere colour so a foggy NIGHT reads as a dim
   *  luminous haze rather than the full daytime whiteout. */
  fogNightColorScale: num({ owner: 'weather', unit: 'ratio', doc: 'Multiplier on the per-weather fog/atmosphere colour at night (dims the daytime-authored haze for the night path).', default: 0.32, min: 0, max: 1 }),

  // CLEAR: bright, crisp, warm-white sun, faint cool-blue distance. High key, normal ambient.
  gradeKeyScaleClear: num({ owner: 'weather', unit: 'ratio', doc: 'Key-light intensity scale for the clear profile (full, crisp daylight).', default: 1, min: 0, max: 3 }),
  gradeAmbientScaleClear: num({ owner: 'weather', unit: 'ratio', doc: 'Ambient fill scale for the clear profile.', default: 1, min: 0, max: 4 }),
  gradeKeyTintClear: num({ owner: 'weather', unit: 'ratio', doc: 'Clear sun tint (warm white), packed 0xRRGGBB sRGB.', default: 0xfff4e0, min: 0, max: 0xffffff, integer: true }),
  gradeAmbientTintClear: num({ owner: 'weather', unit: 'ratio', doc: 'Clear ambient/sky tint (cool blue), packed 0xRRGGBB sRGB.', default: 0xbcd4f2, min: 0, max: 0xffffff, integer: true }),
  gradeFogColorClear: num({ owner: 'weather', unit: 'ratio', doc: 'Clear atmosphere/background colour (bright cool blue, fog far away), packed 0xRRGGBB sRGB.', default: 0x9dbce0, min: 0, max: 0xffffff, integer: true }),

  // RAIN: dimmer, cool desaturated blue-grey, overcast — low key contrast, lifted ambient (soft flat shadows).
  gradeKeyScaleRain: num({ owner: 'weather', unit: 'ratio', doc: 'Key-light intensity scale for the rain profile (overcast, low contrast).', default: 0.5, min: 0, max: 3 }),
  gradeAmbientScaleRain: num({ owner: 'weather', unit: 'ratio', doc: 'Ambient fill scale for the rain profile (lifted so shadows go soft/flat, but kept below fog so rain reads dimmer than the fog whiteout).', default: 1.1, min: 0, max: 4 }),
  gradeKeyTintRain: num({ owner: 'weather', unit: 'ratio', doc: 'Rain sun tint (cool blue-grey), packed 0xRRGGBB sRGB.', default: 0xa6b8cc, min: 0, max: 0xffffff, integer: true }),
  gradeAmbientTintRain: num({ owner: 'weather', unit: 'ratio', doc: 'Rain ambient/sky tint (grey-blue overcast), packed 0xRRGGBB sRGB.', default: 0x8ea2b8, min: 0, max: 0xffffff, integer: true }),
  gradeFogColorRain: num({ owner: 'weather', unit: 'ratio', doc: 'Rain atmosphere/background colour (dim cool desaturated blue-grey — clearly darker than the bright fog whiteout so the two read distinct), packed 0xRRGGBB sRGB.', default: 0x49535f, min: 0, max: 0xffffff, integer: true }),

  // FOG: bright but FLAT — near-white/grey whiteout, very low key contrast, very high ambient. Luminous, not dark.
  gradeKeyScaleFog: num({ owner: 'weather', unit: 'ratio', doc: 'Key-light intensity scale for the fog profile (very low — flat diffuse whiteout).', default: 0.4, min: 0, max: 3 }),
  gradeAmbientScaleFog: num({ owner: 'weather', unit: 'ratio', doc: 'Ambient fill scale for the fog profile (high — luminous diffuse whiteout).', default: 1.85, min: 0, max: 4 }),
  gradeKeyTintFog: num({ owner: 'weather', unit: 'ratio', doc: 'Fog sun tint (neutral cool white), packed 0xRRGGBB sRGB.', default: 0xdfe6ec, min: 0, max: 0xffffff, integer: true }),
  gradeAmbientTintFog: num({ owner: 'weather', unit: 'ratio', doc: 'Fog ambient/sky tint (near-white), packed 0xRRGGBB sRGB.', default: 0xe2e8ee, min: 0, max: 0xffffff, integer: true }),
  gradeFogColorFog: num({ owner: 'weather', unit: 'ratio', doc: 'Fog atmosphere/background colour (bright near-white grey whiteout), packed 0xRRGGBB sRGB.', default: 0xc8cdd0, min: 0, max: 0xffffff, integer: true }),

  // SMOKE: murky ORANGE-BROWN, dim warm key, low ambient — an acrid sooty haze.
  gradeKeyScaleSmoke: num({ owner: 'weather', unit: 'ratio', doc: 'Key-light intensity scale for the smoke profile (dim warm key).', default: 0.65, min: 0, max: 3 }),
  gradeAmbientScaleSmoke: num({ owner: 'weather', unit: 'ratio', doc: 'Ambient fill scale for the smoke profile (low — murky).', default: 0.85, min: 0, max: 4 }),
  gradeKeyTintSmoke: num({ owner: 'weather', unit: 'ratio', doc: 'Smoke sun tint (warm orange), packed 0xRRGGBB sRGB.', default: 0xffae66, min: 0, max: 0xffffff, integer: true }),
  gradeAmbientTintSmoke: num({ owner: 'weather', unit: 'ratio', doc: 'Smoke ambient/sky tint (warm brown-orange), packed 0xRRGGBB sRGB.', default: 0xc28a52, min: 0, max: 0xffffff, integer: true }),
  gradeFogColorSmoke: num({ owner: 'weather', unit: 'ratio', doc: 'Smoke atmosphere/background colour (murky orange-brown), packed 0xRRGGBB sRGB.', default: 0x6b4a2e, min: 0, max: 0xffffff, integer: true }),
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

/** Per-weather atmosphere grade: key/ambient intensity SCALE + key/ambient/fog colour TINT (hex sRGB). The
 *  LightingSystem eases between these on a weather change so the vibe never snaps. Fog DISTANCE is separate
 *  (severity-driven, resolveFogDistances). */
export interface WeatherGrade {
  /** Multiplier on the daytime key (sun/moon) intensity — high = crisp, low = flat overcast/whiteout. */
  readonly keyScale: number;
  /** Multiplier on the ambient/hemisphere fill — high lifts shadows soft/flat (overcast/whiteout). */
  readonly ambientScale: number;
  /** Sun/key light tint, packed 0xRRGGBB sRGB. */
  readonly keyTint: number;
  /** Ambient + hemisphere-sky tint, packed 0xRRGGBB sRGB. */
  readonly ambientTint: number;
  /** Atmosphere/background fog colour (daytime), packed 0xRRGGBB sRGB. Night-dimmed by fogNightColorScale. */
  readonly fogColor: number;
}

interface WeatherGradeResolved {
  gradeKeyScaleClear: number; gradeAmbientScaleClear: number; gradeKeyTintClear: number; gradeAmbientTintClear: number; gradeFogColorClear: number;
  gradeKeyScaleRain: number; gradeAmbientScaleRain: number; gradeKeyTintRain: number; gradeAmbientTintRain: number; gradeFogColorRain: number;
  gradeKeyScaleFog: number; gradeAmbientScaleFog: number; gradeKeyTintFog: number; gradeAmbientTintFog: number; gradeFogColorFog: number;
  gradeKeyScaleSmoke: number; gradeAmbientScaleSmoke: number; gradeKeyTintSmoke: number; gradeAmbientTintSmoke: number; gradeFogColorSmoke: number;
}

/** Select the resolved per-weather atmosphere grade for a profile (the lighting lane eases between profiles). */
export function weatherGrade(resolved: WeatherGradeResolved, profile: WeatherProfile): WeatherGrade {
  switch (profile) {
    case 'clear': return { keyScale: resolved.gradeKeyScaleClear, ambientScale: resolved.gradeAmbientScaleClear, keyTint: resolved.gradeKeyTintClear, ambientTint: resolved.gradeAmbientTintClear, fogColor: resolved.gradeFogColorClear };
    case 'rain': return { keyScale: resolved.gradeKeyScaleRain, ambientScale: resolved.gradeAmbientScaleRain, keyTint: resolved.gradeKeyTintRain, ambientTint: resolved.gradeAmbientTintRain, fogColor: resolved.gradeFogColorRain };
    case 'fog': return { keyScale: resolved.gradeKeyScaleFog, ambientScale: resolved.gradeAmbientScaleFog, keyTint: resolved.gradeKeyTintFog, ambientTint: resolved.gradeAmbientTintFog, fogColor: resolved.gradeFogColorFog };
    case 'smoke': return { keyScale: resolved.gradeKeyScaleSmoke, ambientScale: resolved.gradeAmbientScaleSmoke, keyTint: resolved.gradeKeyTintSmoke, ambientTint: resolved.gradeAmbientTintSmoke, fogColor: resolved.gradeFogColorSmoke };
  }
}
