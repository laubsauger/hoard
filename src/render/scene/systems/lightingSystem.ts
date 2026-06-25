// Lighting system (B5/B6/B13): drives the sun/moon key from the sim clock, anchors its shadow frustum to the
// player, floors the ambient/hemisphere fill, smooths the analytic fog distances + lifts the fog/background
// colour off near-black, and resolves the renderer tone-mapping exposure (interior compensation + night floor,
// smoothed as eyes adapting). Owns the per-frame `interiorTransition` + `exposure` smoothing state. `update`
// returns the normalized scene brightness so the orchestrator can drive the flashlight AFTER lighting (the
// lighting→flashlight order, preserved). Extracted from BlockScene (docs/REFACTOR-godfiles.md).

import { type AmbientLight, Color, type DirectionalLight, type Fog, type HemisphereLight, type Scene } from 'three';
import type { QualityTier } from '../../../config/types';
import type { GameRuntime } from '../../../game/runtime';
import type { WeatherGrade, WeatherProfile } from '../../../config/domains/weather';
import { approach, interiorExposureCompensation, resolveFogDistances, resolveToneExposure } from '../../lighting/lighting';
import { computeSkyState, type SkyWeatherInput } from '../sky';
import { isInside } from './playerLocation';

// Scratch colours reused each frame (no per-frame allocation, B24/V11).
const _targetColor = new Color();

/** Ease a live light Colour toward a hex sRGB target at `rate`/s (frame-rate-independent). dt<=0 snaps. So a
 *  weather change EASES the tint, never snaps — mirrors the fog-distance approach() smoothing (B5). */
function easeColor(live: Color, targetHex: number, rate: number, dtSeconds: number): void {
  _targetColor.setHex(targetHex); // sRGB → linear working space
  const a = dtSeconds <= 0 ? 1 : 1 - Math.exp(-rate * dtSeconds);
  live.r += (_targetColor.r - live.r) * a;
  live.g += (_targetColor.g - live.g) * a;
  live.b += (_targetColor.b - live.b) * a;
}

/** GPU light/fog handles the LightingSystem drives each frame (created + tracked by the orchestrator, V24). */
export interface LightingHandles {
  readonly scene: Scene;
  readonly sun: DirectionalLight;
  readonly ambient: AmbientLight;
  readonly hemi: HemisphereLight;
  readonly fog: Fog;
}

export interface LightingSystemConfig {
  readonly tier: QualityTier;
  readonly navCellSize: number;
  readonly shadowLightDistanceMeters: number;
  readonly baseExposure: number;
  readonly exposureTransitionSeconds: number;
  // Sky inputs (SkyLightingInput superset) + the dayMax brightness denominator.
  readonly sunIntensity: number;
  readonly moonIntensity: number;
  readonly ambientIntensity: number;
  readonly minAmbientIntensity: number;
  readonly fogDistanceSmoothingPerSecond: number;
  readonly fogFloorLuminance: number;
  readonly nightExposureBoostStops: number;
  readonly weather: SkyWeatherInput;
  /** Per-weather atmosphere grade (key/ambient scale + key/ambient/fog tint) selected by the active profile. */
  readonly weatherGrades: Record<WeatherProfile, WeatherGrade>;
  /** Per-second ease rate for the grade scales + tints toward the active profile (so a weather change eases). */
  readonly gradeSmoothingPerSecond: number;
  /** Multiplier on the per-weather fog colour at night (dims the daytime haze for the night path). */
  readonly fogNightColorScale: number;
  /** Night key (moon) light tint, packed 0xRRGGBB sRGB. */
  readonly moonColor: number;
}

export interface LightingResult {
  /** Normalized 0..1 day/night key+ambient level (drives the flashlight intensity downstream). */
  readonly sceneBrightness: number;
  /** Resolved renderer tone-mapping exposure (B6). */
  readonly exposure: number;
  /** Day fraction 0..1 actually used this frame (the dev override if active, else the sim clock) — for the HUD readout (T126). */
  readonly timeOfDay: number;
}

export class LightingSystem {
  /** Smoothed interior/exterior exposure transition 0..1 (B6) — eyes adapting, not a snap. */
  private interiorTransition = 0;
  /** Live tone-mapping exposure (B6) — read by the renderer host each frame. */
  private exposure = 1;
  /** Smoothed per-weather key/ambient intensity scales — eased toward the active profile so a weather change
   *  never snaps the brightness (primed to the clear/full grade; the colours smooth on the live light objects). */
  private gradeKeyScale = 1;
  private gradeAmbientScale = 1;
  /** Smoothed DAYTIME fog/atmosphere base colour — eased toward the active profile's fog hue. The applied
   *  `fog.color` is this × the night dim × the luminance floor, so the night/floor scaling never corrupts the
   *  smoothing accumulator (kept separate from the live fog object). */
  private readonly fogBase = new Color(0x0b0d0a);

  constructor(
    private readonly handles: LightingHandles,
    private readonly cfg: LightingSystemConfig,
  ) {}

  /** Live tone-mapping exposure (B6). */
  get currentExposure(): number {
    return this.exposure;
  }

  /**
   * `timeOfDayOverride` (T126/V91): a render-side DEV override of the day/night phase for lighting tuning.
   * When non-null the lighting uses it INSTEAD of `runtime.timeOfDay()` and the day/night cycle is frozen at
   * that fraction. It is a VIEW override only — the deterministic fixed-tick SIM clock is never touched (V2/V26),
   * so replay stays exact; nothing in the sim reads it.
   */
  update(dtSeconds: number, runtime: GameRuntime, timeOfDayOverride?: number | null): LightingResult {
    const { scene, sun, ambient, hemi, fog } = this.handles;
    const severity = runtime.weatherSeverity;
    const timeOfDay = timeOfDayOverride ?? runtime.timeOfDay();

    // Per-weather grade: ease the key/ambient SCALES toward the active profile (mirrors the fog-distance
    // approach() smoothing) so switching weather never snaps the brightness. The tints smooth on the live
    // light/fog colour objects below.
    const grade = this.cfg.weatherGrades[runtime.weather];
    const gradeRate = this.cfg.gradeSmoothingPerSecond;
    this.gradeKeyScale = approach(this.gradeKeyScale, grade.keyScale, gradeRate, dtSeconds);
    this.gradeAmbientScale = approach(this.gradeAmbientScale, grade.ambientScale, gradeRate, dtSeconds);
    const sky = computeSkyState(timeOfDay, this.cfg, this.cfg.weather, {
      keyScale: this.gradeKeyScale,
      ambientScale: this.gradeAmbientScale,
    });

    const dist = this.cfg.shadowLightDistanceMeters;
    // B13: anchor the key + its shadow frustum to the player so cast shadows always cover the play area
    // (the frustum is capped for sharpness; pinning it to world origin produced a hard shadow cut-off as
    // the player walked away). Sun keeps its sky-driven direction, just translated onto the player.
    const pl = runtime.player();
    sun.position.set(pl.x - sky.direction.x * dist, -sky.direction.y * dist, pl.z - sky.direction.z * dist);
    sun.target.position.set(pl.x, 0, pl.z);
    sun.target.updateMatrixWorld();
    sun.intensity = sky.keyIntensity;
    // Per-weather key TINT by day (warm-white clear, cool rain, neutral fog, orange smoke); the moon tint at
    // night. Eased so a weather change (or the day↔night handover) never snaps the colour.
    easeColor(sun.color, sky.isDay ? grade.keyTint : this.cfg.moonColor, gradeRate, dtSeconds);
    // B6: floor the ambient/hemisphere fill so a low-key night spawn never crushes unlit faces to black.
    const ambientLevel = Math.max(sky.ambientIntensity, this.cfg.minAmbientIntensity);
    ambient.intensity = ambientLevel;
    hemi.intensity = ambientLevel * 0.5;
    // Per-weather ambient/sky TINT (cool overcast for rain, near-white for fog, warm for smoke), eased.
    easeColor(ambient.color, grade.ambientTint, gradeRate, dtSeconds);
    easeColor(hemi.color, grade.ambientTint, gradeRate, dtSeconds);

    // B5: analytic, clamped fog distances (no per-frame stepping-loop banding), smoothed toward target so a
    // weather change never sweeps the fog boundary across the near-ortho frame as bands.
    const target = resolveFogDistances(severity, this.cfg.tier);
    const rate = this.cfg.fogDistanceSmoothingPerSecond;
    fog.far = approach(fog.far, target.far, rate, dtSeconds);
    fog.near = approach(fog.near, target.near, rate, dtSeconds);

    // Per-weather fog/atmosphere COLOUR: the authored daytime hue, dimmed at night (fogNightColorScale) so a
    // foggy night reads as a dim luminous haze, not the daytime whiteout. Eased toward the target so a weather
    // change never sweeps the background colour as a hard cut. B5: a luminance FLOOR keeps the far plane off
    // near-black (never a black void) even for the murky/night-dimmed profiles.
    easeColor(this.fogBase, grade.fogColor, gradeRate, dtSeconds);
    fog.color.copy(this.fogBase);
    if (!sky.isDay) fog.color.multiplyScalar(this.cfg.fogNightColorScale);
    const fogLum = Math.max(fog.color.r, fog.color.g, fog.color.b);
    if (fogLum > 0 && fogLum < this.cfg.fogFloorLuminance) fog.color.multiplyScalar(this.cfg.fogFloorLuminance / fogLum);
    (scene.background as Color).copy(fog.color);

    // B6: resolve the renderer tone-mapping exposure — interior compensation + a night floor so the scene
    // stays viewable after AgX/ACES tone mapping. Smooth the interior transition (eyes adapting).
    const insideTarget = isInside(runtime.scene, this.cfg.navCellSize, pl.x, pl.z) ? 1 : 0;
    const transitionRate = this.cfg.exposureTransitionSeconds > 0 ? 1 / this.cfg.exposureTransitionSeconds : Infinity;
    this.interiorTransition = approach(this.interiorTransition, insideTarget, transitionRate, dtSeconds);
    const dayMax = this.cfg.sunIntensity + this.cfg.ambientIntensity;
    const sceneBrightness = dayMax > 0 ? Math.min(1, Math.max(0, (sky.keyIntensity + sky.ambientIntensity) / dayMax)) : 0;
    this.exposure = resolveToneExposure({
      baseExposure: this.cfg.baseExposure,
      // B44/V92: the interior boost FADES in daylight so leaving a building no longer drops exposure into a
      // dark exterior (the cutaway interior is sunlit, not a cave) — full lift only at a genuinely dark night.
      interiorStops: interiorExposureCompensation(Math.min(1, Math.max(0, this.interiorTransition)), sceneBrightness, this.cfg.tier),
      sceneBrightness,
      nightBoostStops: this.cfg.nightExposureBoostStops,
    });

    return { sceneBrightness, exposure: this.exposure, timeOfDay };
  }
}
