// Lighting system (B5/B6/B13): drives the sun/moon key from the sim clock, anchors its shadow frustum to the
// player, floors the ambient/hemisphere fill, smooths the analytic fog distances + lifts the fog/background
// colour off near-black, and resolves the renderer tone-mapping exposure (interior compensation + night floor,
// smoothed as eyes adapting). Owns the per-frame `interiorTransition` + `exposure` smoothing state. `update`
// returns the normalized scene brightness so the orchestrator can drive the flashlight AFTER lighting (the
// lighting→flashlight order, preserved). Extracted from BlockScene (docs/REFACTOR-godfiles.md).

import { type AmbientLight, Color, type DirectionalLight, type Fog, type HemisphereLight, type Scene } from 'three';
import type { QualityTier } from '../../../config/types';
import type { GameRuntime } from '../../../game/runtime';
import { approach, interiorExposureCompensation, resolveFogDistances, resolveToneExposure } from '../../lighting/lighting';
import { computeSkyState, type SkyWeatherInput } from '../sky';
import { isInside } from './playerLocation';

// Authored cool-grey fog/atmosphere hue (relative channel weights); luminance is lifted off near-black to the
// configured floor so the far plane never reads as a black void (B5). Slightly warmer/brighter by day.
const FOG_HUE = { r: 0.62, g: 0.68, b: 0.78 } as const;
const FOG_DAY_LUMINANCE_BONUS = 0.06;

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
}

export interface LightingResult {
  /** Normalized 0..1 day/night key+ambient level (drives the flashlight intensity downstream). */
  readonly sceneBrightness: number;
  /** Resolved renderer tone-mapping exposure (B6). */
  readonly exposure: number;
  /** Day fraction 0..1 actually used this frame (the dev override if active, else the sim clock) — for the HUD readout (T125). */
  readonly timeOfDay: number;
}

export class LightingSystem {
  /** Smoothed interior/exterior exposure transition 0..1 (B6) — eyes adapting, not a snap. */
  private interiorTransition = 0;
  /** Live tone-mapping exposure (B6) — read by the renderer host each frame. */
  private exposure = 1;

  constructor(
    private readonly handles: LightingHandles,
    private readonly cfg: LightingSystemConfig,
  ) {}

  /** Live tone-mapping exposure (B6). */
  get currentExposure(): number {
    return this.exposure;
  }

  /**
   * `timeOfDayOverride` (T125/V90): a render-side DEV override of the day/night phase for lighting tuning.
   * When non-null the lighting uses it INSTEAD of `runtime.timeOfDay()` and the day/night cycle is frozen at
   * that fraction. It is a VIEW override only — the deterministic fixed-tick SIM clock is never touched (V2/V26),
   * so replay stays exact; nothing in the sim reads it.
   */
  update(dtSeconds: number, runtime: GameRuntime, timeOfDayOverride?: number | null): LightingResult {
    const { scene, sun, ambient, hemi, fog } = this.handles;
    const severity = runtime.weatherSeverity;
    const timeOfDay = timeOfDayOverride ?? runtime.timeOfDay();
    const sky = computeSkyState(timeOfDay, this.cfg, this.cfg.weather, severity);

    const dist = this.cfg.shadowLightDistanceMeters;
    // B13: anchor the key + its shadow frustum to the player so cast shadows always cover the play area
    // (the frustum is capped for sharpness; pinning it to world origin produced a hard shadow cut-off as
    // the player walked away). Sun keeps its sky-driven direction, just translated onto the player.
    const pl = runtime.player();
    sun.position.set(pl.x - sky.direction.x * dist, -sky.direction.y * dist, pl.z - sky.direction.z * dist);
    sun.target.position.set(pl.x, 0, pl.z);
    sun.target.updateMatrixWorld();
    sun.intensity = sky.keyIntensity;
    sun.color.setHex(sky.isDay ? 0xfff2dc : 0xaebed8);
    // B6: floor the ambient/hemisphere fill so a low-key night spawn never crushes unlit faces to black.
    const ambientLevel = Math.max(sky.ambientIntensity, this.cfg.minAmbientIntensity);
    ambient.intensity = ambientLevel;
    hemi.intensity = ambientLevel * 0.5;

    // B5: analytic, clamped fog distances (no per-frame stepping-loop banding), smoothed toward target so a
    // weather change never sweeps the fog boundary across the near-ortho frame as bands.
    const target = resolveFogDistances(severity, this.cfg.tier);
    const rate = this.cfg.fogDistanceSmoothingPerSecond;
    fog.far = approach(fog.far, target.far, rate, dtSeconds);
    fog.near = approach(fog.near, target.near, rate, dtSeconds);

    // B5: lift the fog/background colour off near-black to the configured luminance floor (brighter by day)
    // so distant geometry fades into atmosphere instead of a black void.
    const lum = this.cfg.fogFloorLuminance + (sky.isDay ? FOG_DAY_LUMINANCE_BONUS : 0);
    fog.color.setRGB(FOG_HUE.r * lum, FOG_HUE.g * lum, FOG_HUE.b * lum);
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
      // B44/V91: the interior boost FADES in daylight so leaving a building no longer drops exposure into a
      // dark exterior (the cutaway interior is sunlit, not a cave) — full lift only at a genuinely dark night.
      interiorStops: interiorExposureCompensation(Math.min(1, Math.max(0, this.interiorTransition)), sceneBrightness, this.cfg.tier),
      sceneBrightness,
      nightBoostStops: this.cfg.nightExposureBoostStops,
    });

    return { sceneBrightness, exposure: this.exposure, timeOfDay };
  }
}
