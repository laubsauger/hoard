// T7 / V21 — camera rig pure math: rotate-step, zoom-clamp, pitch-clamp, near-ortho view params.

import { describe, it, expect } from 'vitest';
import {
  rotateStep,
  normalizeYaw,
  clampZoom,
  clampPitch,
  computeViewParams,
  resolveCameraSettings,
} from './camera';

describe('rotateStep / normalizeYaw (V21 90-degree steps)', () => {
  it('rotates clockwise by the step', () => {
    expect(rotateStep(45, 1, 90)).toBe(135);
  });
  it('wraps past 360', () => {
    expect(rotateStep(315, 1, 90)).toBe(45);
  });
  it('rotates counter-clockwise and wraps negative', () => {
    expect(rotateStep(45, -1, 90)).toBe(315);
  });
  it('normalizes arbitrary angles to [0,360)', () => {
    expect(normalizeYaw(-90)).toBe(270);
    expect(normalizeYaw(450)).toBe(90);
  });
});

describe('clampZoom / clampPitch (V21 limited tactical zoom + pitch band)', () => {
  it('clamps zoom into band', () => {
    expect(clampZoom(2, 6, 40)).toBe(6);
    expect(clampZoom(100, 6, 40)).toBe(40);
    expect(clampZoom(18, 6, 40)).toBe(18);
  });
  it('clamps pitch into the ~35-45 band', () => {
    expect(clampPitch(10, 35, 45)).toBe(35);
    expect(clampPitch(90, 35, 45)).toBe(45);
    expect(clampPitch(40, 35, 45)).toBe(40);
  });
  it('throws on inverted bands', () => {
    expect(() => clampZoom(5, 40, 6)).toThrow();
  });
});

describe('computeViewParams (V21 near-orthographic framing)', () => {
  it('places the camera directly above the target at pitch 90', () => {
    const v = computeViewParams({
      target: { x: 5, y: 0, z: -3 },
      yawDeg: 0,
      pitchDeg: 90,
      zoom: 18,
      fovDeg: 18,
      near: 1,
      far: 2000,
    });
    expect(v.position.x).toBeCloseTo(5, 5);
    expect(v.position.z).toBeCloseTo(-3, 5);
    expect(v.position.y).toBeCloseTo(v.distance, 5);
  });

  it('derives distance so the frustum half-height equals zoom', () => {
    const zoom = 18;
    const fovDeg = 18;
    const v = computeViewParams({ target: { x: 0, y: 0, z: 0 }, yawDeg: 45, pitchDeg: 40, zoom, fovDeg, near: 1, far: 2000 });
    const expectedDistance = zoom / Math.tan((fovDeg * Math.PI) / 360);
    expect(v.distance).toBeCloseTo(expectedDistance, 5);
  });

  it('rejects invalid zoom / fov (no silent fallback, V4)', () => {
    expect(() => computeViewParams({ target: { x: 0, y: 0, z: 0 }, yawDeg: 0, pitchDeg: 40, zoom: 0, fovDeg: 18, near: 1, far: 2000 })).toThrow();
  });
});

describe('resolveCameraSettings (V4 config-driven)', () => {
  it('resolves a valid pitch band within the ~35-45 deg window', () => {
    const s = resolveCameraSettings('desktop-high');
    expect(s.pitchDegMin).toBeLessThanOrEqual(s.pitchDegMax);
    expect(s.pitchDegMin).toBeGreaterThanOrEqual(35);
    expect(s.pitchDegMax).toBeLessThanOrEqual(45);
    expect(s.rotationStepDeg).toBe(90);
    expect(s.zoomMin).toBeLessThan(s.zoomMax);
  });
});
