// T7 / V21 — near-orthographic tactical camera rig. Pure math (rotate-step, zoom-clamp, view params)
// is exported standalone and unit-tested without a GPU/DOM. CameraRig is a thin PerspectiveCamera wrapper.
// Near-ortho = narrow FOV at a large derived distance, so the frustum barely converges (V21).

import { PerspectiveCamera, Vector3 } from 'three';
import { resolve } from '../../config/spec';
import { cameraConfig } from '../../config/domains/camera';
import type { QualityTier } from '../../config/types';

const DEG2RAD = Math.PI / 180;
const FULL_TURN = 360;

/** Resolved camera tunables for a tier (V4 — all values come from the camera config domain). */
export interface CameraSettings {
  readonly pitchDegMin: number;
  readonly pitchDegMax: number;
  readonly pitchDegDefault: number;
  readonly yawDegDefault: number;
  readonly rotationStepDeg: number;
  readonly zoomMin: number;
  readonly zoomMax: number;
  readonly zoomDefault: number;
  readonly fovDeg: number;
  readonly near: number;
  readonly far: number;
}

export function resolveCameraSettings(tier: QualityTier): CameraSettings {
  const c = cameraConfig;
  const s: CameraSettings = {
    pitchDegMin: resolve(c.pitchDegreesMin, tier),
    pitchDegMax: resolve(c.pitchDegreesMax, tier),
    pitchDegDefault: resolve(c.pitchDegreesDefault, tier),
    yawDegDefault: resolve(c.yawDegreesDefault, tier),
    rotationStepDeg: resolve(c.rotationStepDegrees, tier),
    zoomMin: resolve(c.zoomMetersMin, tier),
    zoomMax: resolve(c.zoomMetersMax, tier),
    zoomDefault: resolve(c.zoomMetersDefault, tier),
    fovDeg: resolve(c.fovDegrees, tier),
    near: resolve(c.nearPlaneMeters, tier),
    far: resolve(c.farPlaneMeters, tier),
  };
  if (s.pitchDegMin > s.pitchDegMax) {
    throw new Error(`camera pitch band invalid: min ${s.pitchDegMin} > max ${s.pitchDegMax}`);
  }
  if (s.zoomMin > s.zoomMax) {
    throw new Error(`camera zoom band invalid: min ${s.zoomMin} > max ${s.zoomMax}`);
  }
  return s;
}

/** Normalize any angle to [0, 360). */
export function normalizeYaw(yawDeg: number): number {
  const r = yawDeg % FULL_TURN;
  return r < 0 ? r + FULL_TURN : r;
}

/** Rotate yaw by one discrete step (V21 90-degree steps). dir +1 = clockwise, -1 = counter-clockwise. */
export function rotateStep(currentYawDeg: number, dir: 1 | -1, stepDeg: number): number {
  return normalizeYaw(currentYawDeg + dir * stepDeg);
}

/** Clamp tactical zoom (frustum half-height meters) to the configured band (V21). */
export function clampZoom(zoom: number, min: number, max: number): number {
  if (min > max) throw new Error(`zoom clamp band invalid: ${min} > ${max}`);
  return Math.min(max, Math.max(min, zoom));
}

/** Clamp downward pitch to the configured ~35-45 deg band (V21). */
export function clampPitch(pitchDeg: number, min: number, max: number): number {
  if (min > max) throw new Error(`pitch clamp band invalid: ${min} > ${max}`);
  return Math.min(max, Math.max(min, pitchDeg));
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ViewParams {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly fovDeg: number;
  readonly near: number;
  readonly far: number;
  /** Derived camera-to-target distance producing ~`zoom` visible half-height at the narrow FOV. */
  readonly distance: number;
}

export interface ViewInput {
  readonly target: Vec3;
  readonly yawDeg: number;
  readonly pitchDeg: number;
  /** Visible frustum half-height in meters (tactical zoom). */
  readonly zoom: number;
  readonly fovDeg: number;
  readonly near: number;
  readonly far: number;
}

/**
 * Compute camera position from a tactical orbit around `target`.
 * distance = zoom / tan(fov/2): at the camera distance the vertical half-extent equals `zoom`,
 * giving a stable, near-orthographic framing the player controls only via discrete rotate + zoom (V21).
 */
export function computeViewParams(input: ViewInput): ViewParams {
  if (input.zoom <= 0) throw new Error(`zoom must be > 0, got ${input.zoom}`);
  if (input.fovDeg <= 0 || input.fovDeg >= 180) throw new Error(`fovDeg out of range, got ${input.fovDeg}`);
  const halfFov = (input.fovDeg * DEG2RAD) / 2;
  const distance = input.zoom / Math.tan(halfFov);
  const yaw = input.yawDeg * DEG2RAD;
  const pitch = input.pitchDeg * DEG2RAD;
  const horizontal = distance * Math.cos(pitch);
  const vertical = distance * Math.sin(pitch);
  const position: Vec3 = {
    x: input.target.x + horizontal * Math.sin(yaw),
    y: input.target.y + vertical,
    z: input.target.z + horizontal * Math.cos(yaw),
  };
  return { position, target: input.target, fovDeg: input.fovDeg, near: input.near, far: input.far, distance };
}

/** Thin Three.js wrapper. Holds discrete yaw/pitch/zoom state and applies computed view params. */
export class CameraRig {
  readonly camera: PerspectiveCamera;
  readonly settings: CameraSettings;
  private yawDeg: number;
  private pitchDeg: number;
  private zoom: number;
  private target = new Vector3(0, 0, 0);

  constructor(settings: CameraSettings, aspect = 1) {
    this.settings = settings;
    this.camera = new PerspectiveCamera(settings.fovDeg, aspect, settings.near, settings.far);
    this.yawDeg = normalizeYaw(settings.yawDegDefault);
    this.pitchDeg = clampPitch(settings.pitchDegDefault, settings.pitchDegMin, settings.pitchDegMax);
    this.zoom = clampZoom(settings.zoomDefault, settings.zoomMin, settings.zoomMax);
    this.apply();
  }

  rotate(dir: 1 | -1): void {
    this.yawDeg = rotateStep(this.yawDeg, dir, this.settings.rotationStepDeg);
    this.apply();
  }

  setZoom(zoom: number): void {
    this.zoom = clampZoom(zoom, this.settings.zoomMin, this.settings.zoomMax);
    this.apply();
  }

  setPitch(pitchDeg: number): void {
    this.pitchDeg = clampPitch(pitchDeg, this.settings.pitchDegMin, this.settings.pitchDegMax);
    this.apply();
  }

  setTarget(x: number, y: number, z: number): void {
    this.target.set(x, y, z);
    this.apply();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Current discrete state, for diagnostics / save. */
  get state(): { yawDeg: number; pitchDeg: number; zoom: number } {
    return { yawDeg: this.yawDeg, pitchDeg: this.pitchDeg, zoom: this.zoom };
  }

  private apply(): void {
    const v = computeViewParams({
      target: this.target,
      yawDeg: this.yawDeg,
      pitchDeg: this.pitchDeg,
      zoom: this.zoom,
      fovDeg: this.settings.fovDeg,
      near: this.settings.near,
      far: this.settings.far,
    });
    this.camera.position.set(v.position.x, v.position.y, v.position.z);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }
}
