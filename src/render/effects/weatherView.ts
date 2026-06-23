// Weather precipitation visuals (RENDER lane). Gives the diorama atmosphere on top of the existing fog +
// colour grade (which lighting/blockScene own — untouched here). This module adds the ONE thing the slice
// lacked: precipitation.
//
//   RAIN — an instanced set of thin vertical streaks falling inside a box that FOLLOWS the camera/player.
//          Horizontal position is stored as an offset from the box centre so the volume tracks the camera for
//          free; a drop that falls past the ground recycles to the top (groundY + height), so a fixed, capped
//          pool always covers the view (V24 — pooled, no per-frame allocation). Wind gives a slight slant.
//
//   HAZE — fog/smoke profiles read their atmosphere from the EXISTING volumetric fog (blockScene/lighting).
//          We deliberately do NOT add a second fog layer (that would double the extinction). Smoke instead
//          gets a lighter drizzle (config precipIntensitySmoke); fog gets none.
//
// Intensity ramps smoothly toward the active profile's target every frame so a weather change never pops rain
// in/out, and is 0 in clear (gated). All visual-only: render-local RNG, never touches the sim (V2/V3).
//
// r184 binding-safe (V33): solid BoxGeometry + a single shared MeshBasicMaterial (no instanceColor needed —
// every streak shares one tint; intensity scales the material opacity). V56 depth policy: depthTest ON (rain
// is correctly occluded by walls/roofs) + depthWrite OFF — NEVER depthTest:false. Pure RainField is GPU-free
// so the recycle/ramp/wrap logic is unit-tested without a renderer; the thin RainView mirrors it each frame.

import {
  InstancedMesh,
  BoxGeometry,
  MeshBasicMaterial,
  NormalBlending,
  Object3D,
  Color,
  DynamicDrawUsage,
  type Scene,
} from 'three';
import { resolve } from '../../config/spec';
import { weatherConfig, precipTarget, type WeatherProfile } from '../../config/domains/weather';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';

export interface RainSettings {
  readonly poolSize: number;
  readonly areaMeters: number;
  readonly fallHeightMeters: number;
  readonly groundYMeters: number;
  readonly speedMps: number;
  readonly streakLengthMeters: number;
  readonly streakWidthMeters: number;
  readonly windSlant: number;
  readonly opacity: number;
  readonly color: { readonly r: number; readonly g: number; readonly b: number };
  readonly rampPerSecond: number;
  /** Per-profile precipitation intensity targets (0..1) the field ramps toward. */
  readonly targets: Readonly<Record<WeatherProfile, number>>;
}

export function resolveRainSettings(tier: QualityTier): RainSettings {
  return {
    poolSize: resolve(weatherConfig.rainPoolSize, tier),
    areaMeters: resolve(weatherConfig.rainAreaMeters, tier),
    fallHeightMeters: resolve(weatherConfig.rainFallHeightMeters, tier),
    groundYMeters: resolve(weatherConfig.rainGroundYMeters, tier),
    speedMps: resolve(weatherConfig.rainSpeedMps, tier),
    streakLengthMeters: resolve(weatherConfig.rainStreakLengthMeters, tier),
    streakWidthMeters: resolve(weatherConfig.rainStreakWidthMeters, tier),
    windSlant: resolve(weatherConfig.rainWindSlant, tier),
    opacity: resolve(weatherConfig.rainOpacity, tier),
    color: {
      r: resolve(weatherConfig.rainColorR, tier),
      g: resolve(weatherConfig.rainColorG, tier),
      b: resolve(weatherConfig.rainColorB, tier),
    },
    rampPerSecond: resolve(weatherConfig.precipRampPerSecond, tier),
    targets: {
      clear: resolve(weatherConfig.precipIntensityClear, tier),
      rain: resolve(weatherConfig.precipIntensityRain, tier),
      fog: resolve(weatherConfig.precipIntensityFog, tier),
      smoke: resolve(weatherConfig.precipIntensitySmoke, tier),
    },
  };
}

/** Precipitation intensity target (0..1) for a profile, from resolved rain settings. */
export function rainTargetFor(profile: WeatherProfile, settings: RainSettings): number {
  return precipTarget(
    {
      precipIntensityClear: settings.targets.clear,
      precipIntensityRain: settings.targets.rain,
      precipIntensityFog: settings.targets.fog,
      precipIntensitySmoke: settings.targets.smoke,
    },
    profile,
  );
}

// Cheap render-local PRNG — VISUAL only, never touches sim/determinism (V2/V3).
let _seed = 0x9e3779b9 >>> 0;
function rnd(): number {
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 0xffffffff;
}

/** Wrap v into [-h, h] (period 2h). Keeps a drifting horizontal offset inside the box around the camera. */
function wrapSymmetric(v: number, h: number): number {
  if (h <= 0) return 0;
  const period = 2 * h;
  const w = ((v + h) % period + period) % period; // [0, period)
  return w - h;
}

/**
 * Pure rain field (no GPU — unit-tested). A fixed pool of falling streaks. Horizontal position is an OFFSET
 * from the box centre (camera/player), so the volume follows the camera for free; vertical position is the
 * absolute world Y. Each update: ramp intensity toward the target, integrate fall + wind drift, wrap drift
 * back into the box, and recycle a drop to the top once it passes the ground. The pool never grows (V24).
 */
export class RainField {
  /** Horizontal offset from the box centre X (metres, kept in [-area, area]). */
  readonly ox: Float32Array;
  /** Horizontal offset from the box centre Z (metres, kept in [-area, area]). */
  readonly oz: Float32Array;
  /** Absolute world Y of the streak. */
  readonly y: Float32Array;
  /** Per-streak length jitter factor (0.6..1.0) so the curtain doesn't look uniform. */
  readonly lenFactor: Float32Array;
  private _intensity = 0;

  constructor(readonly settings: RainSettings) {
    const n = Math.max(0, settings.poolSize | 0);
    this.ox = new Float32Array(n);
    this.oz = new Float32Array(n);
    this.y = new Float32Array(n);
    this.lenFactor = new Float32Array(n);
    const { areaMeters, groundYMeters, fallHeightMeters } = settings;
    for (let i = 0; i < n; i++) {
      this.ox[i] = (rnd() * 2 - 1) * areaMeters;
      this.oz[i] = (rnd() * 2 - 1) * areaMeters;
      this.y[i] = groundYMeters + rnd() * fallHeightMeters; // spread across the column so it doesn't fall in lockstep
      this.lenFactor[i] = 0.6 + rnd() * 0.4;
    }
  }

  /** Current ramped precipitation intensity (0..1). */
  get intensity(): number {
    return this._intensity;
  }

  /** Hard pool cap — the field never allocates beyond this (V24). */
  get poolSize(): number {
    return this.ox.length;
  }

  /** Number of streaks the view should draw this frame (intensity scales the visible count, capped). */
  get visibleCount(): number {
    const n = Math.round(this._intensity * this.ox.length);
    return Math.max(0, Math.min(this.ox.length, n));
  }

  /** Per-streak slant (horizontal world delta over its length) from the wind. */
  get slantPerLength(): number {
    return this.settings.windSlant;
  }

  /**
   * Advance one frame. `target01` is the active profile's precipitation target (0 in clear → gated off). The
   * box is centred on (centerX, centerZ); drops integrate fall + wind drift independent of intensity (so
   * fading rain in/out never teleports the curtain), and recycle to the top once they pass the ground.
   */
  update(dt: number, target01: number, _centerX: number, _centerZ: number): void {
    if (dt < 0) throw new Error(`dt must be non-negative, got ${dt}`);
    if (target01 < 0 || target01 > 1) throw new Error(`target01 must be in [0,1], got ${target01}`);
    // Smoothly glide intensity toward the target so a weather change never pops (no snap in/out).
    const step = this.settings.rampPerSecond * dt;
    if (this._intensity < target01) this._intensity = Math.min(target01, this._intensity + step);
    else if (this._intensity > target01) this._intensity = Math.max(target01, this._intensity - step);

    const s = this.settings;
    const fall = s.speedMps * dt;
    const drift = s.windSlant * fall; // horizontal drift proportional to fall distance (the slant direction)
    const top = s.groundYMeters + s.fallHeightMeters;
    const n = this.ox.length;
    for (let i = 0; i < n; i++) {
      let ny = this.y[i]! - fall;
      this.ox[i] = wrapSymmetric(this.ox[i]! + drift, s.areaMeters);
      if (ny < s.groundYMeters) {
        // Recycle to the TOP, preserving the sub-cell overshoot so the curtain stays continuous, and
        // re-randomise the horizontal offset + length so recycled drops scatter (V24 — fixed pool).
        const overshoot = (s.groundYMeters - ny) % s.fallHeightMeters;
        ny = top - overshoot;
        this.ox[i] = (rnd() * 2 - 1) * s.areaMeters;
        this.oz[i] = (rnd() * 2 - 1) * s.areaMeters;
        this.lenFactor[i] = 0.6 + rnd() * 0.4;
      }
      this.y[i] = ny;
    }
  }
}

/**
 * Thin GPU view: owns ONE InstancedMesh of thin vertical streaks (solid BoxGeometry) and mirrors the pure
 * RainField onto it each frame. r184 binding-safe (V33) — solid geometry + a single shared material (no
 * instanceColor; every streak shares one tint, intensity drives the material opacity). V56 depth policy:
 * depthTest ON (rain is occluded by walls/roof), depthWrite OFF. All resources tracked for disposal (V24).
 */
export class WeatherView {
  readonly field: RainField;
  private readonly mesh: InstancedMesh;
  private readonly material: MeshBasicMaterial;
  private readonly dummy = new Object3D();
  private readonly baseOpacity: number;

  constructor(settings: RainSettings, registry: ResourceRegistry) {
    this.field = new RainField(settings);
    this.baseOpacity = settings.opacity;

    // A thin, unit-tall vertical bar; the dummy scales it to (width, length, width) per streak.
    const geo = registry.track(new BoxGeometry(1, 1, 1), 'geometry', 'weather.rainGeo');
    this.material = registry.track(
      new MeshBasicMaterial({
        name: 'weather.rain',
        color: new Color(settings.color.r, settings.color.g, settings.color.b),
        toneMapped: false,
        transparent: true,
        blending: NormalBlending,
        depthWrite: false, // V56 — depthTest stays ON (default) so walls/roofs occlude rain; never depthTest:false
        opacity: 0,
      }),
      'material',
      'weather.rainMat',
    );
    const cap = Math.max(1, settings.poolSize); // InstancedMesh needs >=1 capacity even if the pool is empty
    this.mesh = registry.track(new InstancedMesh(geo, this.material, cap), 'buffer', 'weather.rainMesh');
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false; // the curtain follows the camera; its bounds are meaningless
    this.mesh.count = 0;
    this.mesh.renderOrder = 4; // after opaque + decals/sparks; it's a translucent overlay
    this.mesh.visible = false;
  }

  /** Add the rain mesh to the scene graph (parent owns graph membership; registry owns disposal). */
  attachTo(scene: Scene | Object3D): void {
    scene.add(this.mesh);
  }

  /**
   * Advance the field for the active weather `profile` (box centred on the camera/player) and mirror it onto
   * the instanced batch. Intensity ramps toward the profile target; at 0 (clear/fog) the mesh is hidden.
   */
  update(dt: number, profile: WeatherProfile, centerX: number, centerZ: number): void {
    const target = rainTargetFor(profile, this.field.settings);
    this.field.update(dt, target, centerX, centerZ);

    const intensity = this.field.intensity;
    if (intensity <= 0 || this.field.poolSize === 0) {
      this.mesh.count = 0;
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.material.opacity = this.baseOpacity * intensity;

    const s = this.field.settings;
    const count = this.field.visibleCount;
    // Lean the streak by the wind slant: a small tilt around Z so it reads as wind-blown rain.
    const tilt = Math.atan(s.windSlant);
    for (let i = 0; i < count; i++) {
      const len = s.streakLengthMeters * this.field.lenFactor[i]!;
      this.dummy.position.set(centerX + this.field.ox[i]!, this.field.y[i]!, centerZ + this.field.oz[i]!);
      this.dummy.rotation.set(0, 0, tilt);
      this.dummy.scale.set(s.streakWidthMeters, len, s.streakWidthMeters);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
