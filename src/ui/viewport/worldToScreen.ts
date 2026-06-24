// T113 / V11 — pure world→screen projection for the world-anchored interaction prompt (the "{F} to {action}"
// hint floats NEXT TO the real object instead of being pinned at the screen bottom). Reuses the SAME tactical
// camera the aim raycaster uses (no second projection path): a world point is run through the camera's already-
// updated view + projection matrices to NDC, then mapped NDC → CSS viewport pixels (origin = top-left). GPU-free
// + DOM-free (just matrix math on a Three Camera) so it is unit-testable headless (V27).

import { Vector3, type Camera } from 'three';

export interface ScreenPoint {
  /** CSS px from the LEFT of the viewport. */
  readonly x: number;
  /** CSS px from the TOP of the viewport. */
  readonly y: number;
  /** True when the world point is BEHIND the camera plane (the perspective divide mirrors it — caller hides). */
  readonly behind: boolean;
}

// Reused scratch vector — module-private, single-threaded, never escapes: zero per-call allocation (V24).
const scratch = new Vector3();

/**
 * Project a world point (x,y,z meters) through `camera` to viewport pixels (origin = top-left). `behind` is true
 * when the point is behind the camera plane (view-space z ≥ 0). Pure: depends only on the camera's matrices
 * (already refreshed by the rig each frame) + the viewport size — no DOM read, no side effect.
 */
export function worldToScreen(
  camera: Camera,
  x: number,
  y: number,
  z: number,
  viewportW: number,
  viewportH: number,
): ScreenPoint {
  scratch.set(x, y, z).applyMatrix4(camera.matrixWorldInverse); // → view space (camera looks down -Z)
  const behind = scratch.z >= 0; // +Z is behind the camera in view space
  scratch.applyMatrix4(camera.projectionMatrix); // → NDC (applyMatrix4 does the perspective divide by w)
  return {
    x: (scratch.x * 0.5 + 0.5) * viewportW,
    y: (1 - (scratch.y * 0.5 + 0.5)) * viewportH,
    behind,
  };
}

/** Clamp a screen point into [margin, size−margin] on both axes so the prompt stays fully on-screen. Pure. */
export function clampScreenPoint(
  p: ScreenPoint,
  viewportW: number,
  viewportH: number,
  marginPx: number,
): ScreenPoint {
  const x = Math.min(Math.max(p.x, marginPx), Math.max(marginPx, viewportW - marginPx));
  const y = Math.min(Math.max(p.y, marginPx), Math.max(marginPx, viewportH - marginPx));
  return { x, y, behind: p.behind };
}
