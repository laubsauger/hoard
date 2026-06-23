// T96 / V14 — vision-cone fog-of-war cull (pure logic, no three/GPU).
// Zombies are drawn ONLY inside the player's forward vision cone + range + line-of-sight (Project-Zomboid
// "look-around" survival mood). This is the SAME forward-cone awareness the dev overlay already draws and
// reuses the canonical V14 cone predicate `withinCone`. Applied where the crowd instance buffers are PACKED
// (packCrowdInputs / packLimbInputs) so culled members are never submitted to the GPU at all. A soft band
// near the cone edge + max range fades members out (cheap: fades the packed instance ALPHA toward zero (V65)) so threats
// fade in rather than hard-pop. Reads nothing back into the sim (V1/V3).

import { withinCone } from '../../game/runtime/hordeSystems';

/** Per-frame player vision wedge the crowd cull tests against. Distances/angles are world meters / radians. */
export interface VisionCull {
  /** Player position (XZ, world meters). */
  readonly px: number;
  readonly pz: number;
  /** Player aim heading (radians, atan2(dirZ,dirX)) — the cone's centre direction. */
  readonly heading: number;
  /** Half the player field-of-view (radians). >= π = omnidirectional (no cone gate). */
  readonly fovHalf: number;
  /** Max reveal distance (meters). Beyond this a member is hidden. */
  readonly range: number;
  /** Soft fade band width at the FAR edge (meters); members within it fade toward zero. 0 = hard edge. */
  readonly edgeBandMeters: number;
  /** Soft fade band width at the CONE edge (radians); members near it fade toward zero. 0 = hard edge. */
  readonly edgeBandRadians: number;
  /** Optional wall line-of-sight test: true = clear path, false = blocked. Omitted = ignore occlusion. */
  readonly lineOfSight?: (x0: number, z0: number, x1: number, z1: number) => boolean;
  /**
   * Optional PRECOMPUTED per-slot reveal (V62 perception v2): when present, packing reads `reveal[slot]` instead
   * of recomputing the cone fade — this carries the combined max(cone, near, memory, noise) reveal the scene
   * computes once per frame (incl. the stateful recently-seen memory). Indexed by SoA slot; sized to capacity.
   */
  readonly reveal?: Float32Array;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Render-visibility fade for a crowd member at (x,z): 1 = fully visible, 0 = culled (do not draw). A value in
 * (0,1) means the member is inside the wedge but within a soft edge band — the caller multiplies the packed
 * instance ALPHA by it (V65) so the member blends out smoothly instead of popping or shrinking. O(1) cone+range test; the
 * (optional) LOS DDA only runs for members that already passed cone+range, so it stays cheap per frame.
 */
export function visionCullFade(x: number, z: number, c: VisionCull): number {
  const dx = x - c.px;
  const dz = z - c.pz;
  const dist = Math.hypot(dx, dz);
  if (dist > c.range) return 0; // beyond the reveal range
  if (!withinCone(dx, dz, c.heading, c.fovHalf)) return 0; // outside the forward cone (V14)
  if (c.lineOfSight && !c.lineOfSight(c.px, c.pz, x, z)) return 0; // occluded by a wall
  // Soft band: fade toward 0 approaching BOTH the far edge and the cone edge (min of the two).
  const rangeFade = c.edgeBandMeters > 0 ? clamp01((c.range - dist) / c.edgeBandMeters) : 1;
  let coneFade = 1;
  if (c.edgeBandRadians > 0 && c.fovHalf < Math.PI) {
    const diff = Math.atan2(dz, dx) - c.heading;
    const ang = Math.abs(Math.atan2(Math.sin(diff), Math.cos(diff)));
    coneFade = clamp01((c.fovHalf - ang) / c.edgeBandRadians);
  }
  return Math.min(rangeFade, coneFade);
}
