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

/** Per-weather intensity grade the sky math consumes (the SMOOTHED key/ambient scales the LightingSystem eases
 *  between profiles). Replaces the old single `weatherDim` scalar so each weather gets its own key + fill vibe
 *  (e.g. fog = low key, high ambient = flat luminous whiteout; rain = lower key, lifted ambient = soft overcast). */
export interface SkyGrade {
  /** Multiplier on the key (sun/moon) intensity. */
  readonly keyScale: number;
  /** Multiplier on the ambient fill. */
  readonly ambientScale: number;
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
 * over (opposite phase). Azimuth sweeps with time around the configured diagonal anchor. The per-weather
 * `grade` scales the key + ambient independently so each profile has its own light vibe (overcast lifts the
 * fill while dropping the key; a clear day keeps a high key + normal fill).
 */
export function computeSkyState(
  timeOfDay: number,
  lighting: SkyLightingInput,
  weather: SkyWeatherInput,
  grade: SkyGrade,
): SkyState {
  if (timeOfDay < 0 || timeOfDay > 1) throw new Error(`timeOfDay must be in [0,1], got ${timeOfDay}`);
  if (grade.keyScale < 0) throw new Error(`grade.keyScale must be non-negative, got ${grade.keyScale}`);
  if (grade.ambientScale < 0) throw new Error(`grade.ambientScale must be non-negative, got ${grade.ambientScale}`);

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

  const keyIntensity = (lighting.moonIntensity + (lighting.sunIntensity - lighting.moonIntensity) * Math.max(0, sunSin)) * grade.keyScale;
  const ambientIntensity = lighting.ambientIntensity * (0.35 + 0.65 * Math.max(0, sunSin)) * grade.ambientScale;

  return { direction, keyIntensity, ambientIntensity, isDay, elevation01 };
}

/** Coarse day/night phase label for the HUD readout + dev controls (T126). */
export type DayPhase = 'dawn' | 'day' | 'dusk' | 'night';

/**
 * Derive the day/night PHASE from the same day fraction the lighting uses — single-sourced from the SAME
 * `sin(2π·(t−0.25))` sun elevation `computeSkyState` drives (so the label can never disagree with the actual
 * sun): zenith at noon (t=0.5), horizon at dawn (t≈0.25) / dusk (t≈0.75), below the horizon at night. Dawn/dusk
 * are the thin twilight bands either side of the horizon crossing (|elevation| within DUSK_BAND of 0).
 */
const DUSK_BAND = 0.18; // |sin elevation| below this near a horizon crossing reads as twilight (dawn/dusk)
export function dayPhaseOf(timeOfDay: number): DayPhase {
  if (timeOfDay < 0 || timeOfDay > 1) throw new Error(`timeOfDay must be in [0,1], got ${timeOfDay}`);
  const sunSin = Math.sin(TAU * (timeOfDay - 0.25)); // +1 noon, 0 dawn/dusk, -1 midnight
  if (Math.abs(sunSin) <= DUSK_BAND) return timeOfDay < 0.5 ? 'dawn' : 'dusk'; // first half of the day rises (dawn)
  return sunSin > 0 ? 'day' : 'night';
}

/** Format a 0..1 day fraction as a 24-hour HH:MM clock (t=0 → 00:00, t=0.5 → 12:00). Pure, for the HUD (T126). */
export function formatTimeOfDay(timeOfDay: number): string {
  if (timeOfDay < 0 || timeOfDay > 1) throw new Error(`timeOfDay must be in [0,1], got ${timeOfDay}`);
  const totalMinutes = Math.floor(timeOfDay * 1440) % 1440; // 1440 minutes per day
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
