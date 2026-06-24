// §V78 / T112 — PURE visibility-polygon math for the dev vision overlay.
//
// Given an agent apex, heading, FOV half-angle, sight/vision range, a ray-SEGMENT count, and a
// `distanceAt(angle)` occluder query, produce the RIM of the OCCLUDED visibility polygon: the clipped
// world-XZ endpoints of `segments+1` rays fanned across [heading−fovHalf, heading+fovHalf]. A clear ray
// reaches `range`; a ray hitting an occluder at d<range stops at d (a shadow notch). The caller backs
// `distanceAt` with `rayDistanceToWall` on the SAME nav grid the shots (V53/B20) + perception LOS +
// flashlight clamp (V67) use — so this helper is GPU-free, scene-free, deterministic, and unit-testable.
//
// Allocation-free when a correctly-sized `out` buffer is supplied (V24) — the overlay reuses one scratch.

/**
 * World-XZ rim points of the occluded visibility polygon: a flat `[x0,z0, x1,z1, …]` array of the
 * `segments+1` ray endpoints (apex + clipped distance along each fanned angle). The caller owns the apex
 * and builds the stroke (apex → rim → apex). Writes into `out` when it is large enough (no allocation).
 *
 * @param apexX cone origin X (world meters)
 * @param apexZ cone origin Z (world meters)
 * @param heading facing (radians) — the fan is centred on this
 * @param fovHalf cone HALF-angle (radians); the fan spans [heading−fovHalf, heading+fovHalf]
 * @param range max sight/vision range (m) — a clear ray reaches exactly this
 * @param segments ray SEGMENTS across the fan (>=1) — yields `segments+1` rim points
 * @param distanceAt distance (m) to the first occluder along `angle`; the result is clamped to `range`
 * @param out optional preallocated buffer (length >= `2*(segments+1)`), rewritten in place
 */
export function occludedVisibilityRim(
  apexX: number,
  apexZ: number,
  heading: number,
  fovHalf: number,
  range: number,
  segments: number,
  distanceAt: (angle: number) => number,
  out?: Float32Array,
): Float32Array {
  const segs = Math.max(1, Math.floor(segments));
  const points = segs + 1;
  const need = points * 2;
  const rim = out && out.length >= need ? out : new Float32Array(need);
  const span = 2 * fovHalf;
  for (let i = 0; i < points; i++) {
    const a = heading - fovHalf + (span * i) / segs;
    const d = Math.min(range, distanceAt(a));
    rim[i * 2] = apexX + Math.cos(a) * d;
    rim[i * 2 + 1] = apexZ + Math.sin(a) * d;
  }
  return rim;
}
