// T38 — pure day/night sky math. Maps a 0..1 day fraction (from the sim clock) to a directional key-light
// (sun by day / moon by night), its intensity, and an ambient floor, dimmed by weather severity. No GPU,
// no Three.js — fully unit-testable so "lighting angle follows the clock" is a logic assertion (V12/V4).

const TAU = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

/** Resolved lighting tunables this helper consumes (subset of the lighting config domain). */
export interface SkyLightingInput {
  readonly sunIntensity: number;
  readonly moonIntensity: number;
  readonly ambientIntensity: number;
}

/** Resolved weather/day-night geometry tunables (subset of the weather config domain). */
export interface SkyWeatherInput {
  readonly sunElevationMaxDegrees: number;
  readonly moonElevationMaxDegrees: number;
  readonly sunAzimuthDegrees: number;
}

export interface SkyState {
  /** Normalized direction the key light TRAVELS (from the sky body toward the ground). y < 0 by day. */
  readonly direction: { readonly x: number; readonly y: number; readonly z: number };
  /** Key directional-light intensity (sun↔moon blended across dawn/dusk). */
  readonly keyIntensity: number;
  /** Ambient fill intensity (lower at night and in heavy weather). */
  readonly ambientIntensity: number;
  /** True while the sun is above the horizon. */
  readonly isDay: boolean;
  /** Active body elevation, 0 (horizon) .. 1 (zenith). */
  readonly elevation01: number;
}

/**
 * Compute the sky state for a day fraction. The sun's elevation tracks sin(2π·(t−0.25)): horizon at dawn
 * (t=0.25) and dusk (t=0.75), zenith at noon (t=0.5), below the horizon at night. At night the moon takes
 * over (opposite phase). Azimuth sweeps with time around the configured diagonal anchor. Weather severity
 * 0..1 attenuates the key + ambient (overcast / smoke darkens the scene).
 */
export function computeSkyState(
  timeOfDay: number,
  lighting: SkyLightingInput,
  weather: SkyWeatherInput,
  weatherSeverity: number,
): SkyState {
  if (timeOfDay < 0 || timeOfDay > 1) throw new Error(`timeOfDay must be in [0,1], got ${timeOfDay}`);
  if (weatherSeverity < 0 || weatherSeverity > 1) throw new Error(`weatherSeverity must be in [0,1], got ${weatherSeverity}`);

  const sunSin = Math.sin(TAU * (timeOfDay - 0.25)); // +1 noon, 0 dawn/dusk, -1 midnight
  const isDay = sunSin >= 0;
  const elevation01 = Math.min(1, Math.abs(sunSin));
  const elevDeg = elevation01 * (isDay ? weather.sunElevationMaxDegrees : weather.moonElevationMaxDegrees);
  const elevRad = elevDeg * DEG2RAD;

  // Azimuth sweeps a half-turn across the day; the moon rides the opposite side of the sky.
  const azimuthRad = weather.sunAzimuthDegrees * DEG2RAD + (timeOfDay - 0.5) * Math.PI + (isDay ? 0 : Math.PI);

  // Position of the light body on a unit hemisphere; the light travels from there toward the origin.
  const px = Math.cos(elevRad) * Math.sin(azimuthRad);
  const py = Math.sin(elevRad);
  const pz = Math.cos(elevRad) * Math.cos(azimuthRad);
  const len = Math.hypot(px, py, pz) || 1;
  const direction = { x: -px / len, y: -py / len, z: -pz / len };

  const weatherDim = 1 - 0.6 * weatherSeverity;
  const keyIntensity = (lighting.moonIntensity + (lighting.sunIntensity - lighting.moonIntensity) * Math.max(0, sunSin)) * weatherDim;
  const ambientIntensity = lighting.ambientIntensity * (0.35 + 0.65 * Math.max(0, sunSin)) * weatherDim;

  return { direction, keyIntensity, ambientIntensity, isDay, elevation01 };
}
