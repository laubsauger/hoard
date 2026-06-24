// T113 — unit tests for the pure world→screen projection helper (headless: a real Three PerspectiveCamera,
// no GPU/DOM). Verifies the on-axis point lands at viewport centre, off-axis points map to the correct side,
// points behind the camera are flagged, and the clamp keeps a point fully on-screen.

import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { worldToScreen, clampScreenPoint } from './worldToScreen';

/** A tactical-ish camera: above + behind the origin, looking down at it (mirrors the CameraRig framing). */
function makeCamera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(50, 1, 0.1, 100);
  cam.position.set(0, 10, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true); // refreshes matrixWorld AND matrixWorldInverse (Camera override)
  return cam;
}

describe('worldToScreen', () => {
  const W = 800;
  const H = 600;

  it('projects the look-at target to viewport centre', () => {
    const cam = makeCamera();
    const p = worldToScreen(cam, 0, 0, 0, W, H);
    expect(p.behind).toBe(false);
    expect(p.x).toBeCloseTo(W / 2, 1);
    expect(p.y).toBeCloseTo(H / 2, 1);
  });

  it('maps +X to the right and -X to the left of centre', () => {
    const cam = makeCamera();
    const right = worldToScreen(cam, 3, 0, 0, W, H);
    const left = worldToScreen(cam, -3, 0, 0, W, H);
    expect(right.x).toBeGreaterThan(W / 2);
    expect(left.x).toBeLessThan(W / 2);
    expect(right.behind).toBe(false);
    expect(left.behind).toBe(false);
  });

  it('flags a point behind the camera', () => {
    const cam = makeCamera();
    // The camera sits at z=10 looking toward -z; a point further out at z=30 is behind it.
    const p = worldToScreen(cam, 0, 10, 30, W, H);
    expect(p.behind).toBe(true);
  });

  it('y grows downward (a higher world point projects nearer the top)', () => {
    const cam = makeCamera();
    const low = worldToScreen(cam, 0, 0, 0, W, H);
    const high = worldToScreen(cam, 0, 3, 0, W, H);
    expect(high.y).toBeLessThan(low.y);
  });
});

describe('clampScreenPoint', () => {
  it('leaves an in-bounds point untouched', () => {
    const p = clampScreenPoint({ x: 400, y: 300, behind: false }, 800, 600, 12);
    expect(p.x).toBe(400);
    expect(p.y).toBe(300);
  });

  it('clamps points past the edges into the margin band', () => {
    const tl = clampScreenPoint({ x: -50, y: -50, behind: false }, 800, 600, 12);
    expect(tl.x).toBe(12);
    expect(tl.y).toBe(12);
    const br = clampScreenPoint({ x: 9000, y: 9000, behind: false }, 800, 600, 12);
    expect(br.x).toBe(800 - 12);
    expect(br.y).toBe(600 - 12);
  });

  it('preserves the behind flag', () => {
    const p = clampScreenPoint({ x: 10, y: 10, behind: true }, 800, 600, 12);
    expect(p.behind).toBe(true);
  });
});
