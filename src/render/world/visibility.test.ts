// T28 / V20 — occlusion decision: roof fades, base preserved, hidden interior stays hidden; threat language.

import { describe, it, expect } from 'vitest';
import {
  resolveVisibilitySettings,
  resolveSurfaceVisibility,
  resolveCutawayDepthSettings,
  resolveCutawayDepthOffset,
  wallFacesCamera,
  exteriorWallOccludesPlayer,
  wallBetweenPlayerAndCamera,
  clampConeRangeToWall,
  classifyThreat,
  threatMarkerStyle,
  type OcclusionContext,
  type VecXZ,
} from './visibility';

const settings = resolveVisibilitySettings('desktop-high');

const ctx = (over: Partial<OcclusionContext>): OcclusionContext => ({
  playerInside: false,
  occludesPlayerView: false,
  roomEnclosed: true,
  portalOrLosToCamera: false,
  surfaceHeightMeters: 3,
  ...over,
});

describe('resolveSurfaceVisibility (T28/V20)', () => {
  it('always keeps the wall base opaque to read enclosure + breach', () => {
    const v = resolveSurfaceVisibility('baseWall', ctx({ occludesPlayerView: true }), settings);
    expect(v.visible).toBe(true);
    expect(v.targetOpacity).toBe(1);
  });

  it('fades the roof to the SLIVER min-opacity (NOT 0) when it encloses + occludes the player view (V65)', () => {
    const v = resolveSurfaceVisibility('roof', ctx({ roomEnclosed: true, occludesPlayerView: true }), settings);
    // V65: a faded surface keeps rendering a faint hint — it never fully vanishes (target is the sliver floor, not 0).
    expect(v.targetOpacity).toBe(settings.minOpacity);
    expect(settings.minOpacity).toBeGreaterThan(0);
    expect(settings.minOpacity).toBeLessThan(1);
  });

  it('keeps the roof fully opaque when it does not occlude the player view', () => {
    const v = resolveSurfaceVisibility('roof', ctx({ roomEnclosed: true, occludesPlayerView: false }), settings);
    expect(v.targetOpacity).toBe(1);
  });

  it('fades upper wall sections above the fade-start height to the sliver, keeps base-band sections opaque (V65)', () => {
    const high = resolveSurfaceVisibility('upperWall', ctx({ surfaceHeightMeters: 4, occludesPlayerView: true }), settings);
    expect(high.targetOpacity).toBe(settings.minOpacity);
    const low = resolveSurfaceVisibility('upperWall', ctx({ surfaceHeightMeters: settings.baseHeightMeters - 0.1, occludesPlayerView: true }), settings);
    expect(low.targetOpacity).toBe(1);
  });

  it('does NOT reveal an interior just because the camera is above (V20)', () => {
    // camera above => occludesPlayerView true, but no portal/LOS and player not inside.
    const v = resolveSurfaceVisibility('interior', ctx({ occludesPlayerView: true, portalOrLosToCamera: false, playerInside: false }), settings);
    expect(v.visible).toBe(false);
    expect(v.targetOpacity).toBe(0);
  });

  it('reveals an interior only via player presence or portal/LOS', () => {
    expect(resolveSurfaceVisibility('interior', ctx({ playerInside: true }), settings).visible).toBe(true);
    expect(resolveSurfaceVisibility('interior', ctx({ portalOrLosToCamera: true }), settings).visible).toBe(true);
  });
});

describe('directional cutaway — wallFacesCamera (T82/V58)', () => {
  const threshold = settings.cameraFacingDotThreshold;
  // Axis-aligned room: each wall's outward normal points away from the interior.
  const NORTH: VecXZ = { x: 0, z: -1 };
  const SOUTH: VecXZ = { x: 0, z: 1 };
  const EAST: VecXZ = { x: 1, z: 0 };
  const WEST: VecXZ = { x: -1, z: 0 };
  const faces = (outwardNormal: VecXZ, towardCamera: VecXZ): boolean =>
    wallFacesCamera({ outwardNormal, towardCamera, facingDotThreshold: threshold });

  it('resolves a sane cosine threshold (config, per tier)', () => {
    expect(threshold).toBeGreaterThan(-1);
    expect(threshold).toBeLessThan(1);
  });

  it('fades the wall the camera looks AT but not the opposite (far) wall — camera due east', () => {
    const toCam: VecXZ = { x: 1, z: 0 }; // camera east of the player
    expect(faces(EAST, toCam)).toBe(true); // near/camera-facing wall fades
    expect(faces(WEST, toCam)).toBe(false); // opposite far wall stays opaque (reads enclosure)
  });

  it('fades exactly the two near sides on a diagonal (iso) view, never all four', () => {
    const toCam: VecXZ = { x: 1, z: 1 }; // north-east-ish iso camera
    const faded = [NORTH, SOUTH, EAST, WEST].filter((n) => faces(n, toCam));
    expect(faded).toHaveLength(2); // the two camera-facing sides, NOT a roofless open box
    expect(faces(EAST, toCam)).toBe(true);
    expect(faces(SOUTH, toCam)).toBe(true);
    expect(faces(NORTH, toCam)).toBe(false);
    expect(faces(WEST, toCam)).toBe(false);
  });

  it('rotates the faded set with the camera (yaw) — camera due south fades the south wall', () => {
    const toCam: VecXZ = { x: 0, z: 1 };
    expect(faces(SOUTH, toCam)).toBe(true);
    expect(faces(NORTH, toCam)).toBe(false);
  });

  it('a grazing/perpendicular wall (dot ~0) does NOT fade (below threshold)', () => {
    expect(faces(NORTH, { x: 1, z: 0 })).toBe(false); // normal perpendicular to view → kept
  });

  it('a degenerate (zero-length) direction never occludes', () => {
    expect(faces(EAST, { x: 0, z: 0 })).toBe(false);
    expect(wallFacesCamera({ outwardNormal: { x: 0, z: 0 }, towardCamera: { x: 1, z: 0 }, facingDotThreshold: threshold })).toBe(false);
  });

  it('feeds the upperWall decision: a camera-facing wall fades to the sliver, the far wall stays opaque', () => {
    const toCam: VecXZ = { x: 1, z: 0 };
    const near = resolveSurfaceVisibility('upperWall', ctx({ surfaceHeightMeters: 4, occludesPlayerView: faces(EAST, toCam) }), settings);
    const far = resolveSurfaceVisibility('upperWall', ctx({ surfaceHeightMeters: 4, occludesPlayerView: faces(WEST, toCam) }), settings);
    expect(near.targetOpacity).toBe(settings.minOpacity);
    expect(far.targetOpacity).toBe(1);
  });
});

describe('generic player↔camera occlusion — wallBetweenPlayerAndCamera (V66)', () => {
  const span = settings.occluderLateralSpanMeters;
  // An interior dividing wall on the plane x = 0 (outward normal along +X). Player on the −X side.
  const NORMAL: VecXZ = { x: 1, z: 0 };
  const wallCenter: VecXZ = { x: 0, z: 0 };
  const occ = (player: VecXZ, camera: VecXZ, lateralSpanMeters = span): boolean =>
    wallBetweenPlayerAndCamera({ outwardNormal: NORMAL, wallCenter, player, camera, lateralSpanMeters });

  it('resolves a positive lateral span from config', () => {
    expect(span).toBeGreaterThan(0);
  });

  it('fades an INTERIOR wall whose plane lies between the player and the camera (opposite sides)', () => {
    // player at x=-3, camera at x=+3 → the x=0 plane separates them, crossing at the wall centre.
    expect(occ({ x: -3, z: 0 }, { x: 3, z: 0 })).toBe(true);
  });

  it('does NOT fade when player + camera are on the SAME side (the FAR wall stays to read enclosure)', () => {
    expect(occ({ x: -3, z: 0 }, { x: -1, z: 0 })).toBe(false);
    expect(occ({ x: 3, z: 0 }, { x: 1, z: 0 })).toBe(false);
  });

  it('does NOT fade when the crossing point is beyond the lateral span of the wall centre', () => {
    // The plane is crossed, but far down the wall (large |z|) → off this wall section, kept.
    expect(occ({ x: -3, z: span + 5 }, { x: 3, z: span + 5 })).toBe(false);
  });

  it('a degenerate (zero-length) normal never occludes', () => {
    expect(wallBetweenPlayerAndCamera({ outwardNormal: { x: 0, z: 0 }, wallCenter, player: { x: -3, z: 0 }, camera: { x: 3, z: 0 }, lateralSpanMeters: span })).toBe(false);
  });

  it('does not depend on the sign of the normal (plane orientation is symmetric)', () => {
    const flipped = wallBetweenPlayerAndCamera({ outwardNormal: { x: -1, z: 0 }, wallCenter, player: { x: -3, z: 0 }, camera: { x: 3, z: 0 }, lateralSpanMeters: span });
    expect(flipped).toBe(true);
  });
});

describe('raycast-clamped flashlight reach — clampConeRangeToWall (V67)', () => {
  it('clips the reach to the wall distance plus the lit-face margin', () => {
    expect(clampConeRangeToWall(20, 6, 0.6)).toBeCloseTo(6.6);
  });

  it('a clear aim (wall at max range) keeps the full reach, never overshooting it', () => {
    expect(clampConeRangeToWall(20, 20, 0.6)).toBe(20);
  });

  it('never returns negative', () => {
    expect(clampConeRangeToWall(20, -5, 0)).toBe(0);
  });
});

describe('outside-wall cutaway — exteriorWallOccludesPlayer (V62)', () => {
  const adjacencyMeters = settings.exteriorCutawayAdjacencyMeters;
  // A SOUTH-facing exterior wall: its plane is at z=10, outward normal points south (+z toward open space).
  const SOUTH: VecXZ = { x: 0, z: 1 };
  const wallCenter: VecXZ = { x: 0, z: 10 };

  it('resolves a positive adjacency band from config', () => {
    expect(adjacencyMeters).toBeGreaterThan(0);
  });

  it('fades the near wall when the player hugs it OUTSIDE and the camera is beyond it (the plane separates them)', () => {
    const player: VecXZ = { x: 0, z: 10 + adjacencyMeters * 0.4 }; // just OUTSIDE (outward side, within band)
    const camera: VecXZ = { x: 0, z: 4 }; // INWARD (building) side of the wall → wall is between camera + player
    expect(exteriorWallOccludesPlayer({ outwardNormal: SOUTH, wallCenter, player, camera, adjacencyMeters })).toBe(true);
  });

  it('does NOT fade when the camera is on the SAME (outward) side as the player — wall is not between them', () => {
    const player: VecXZ = { x: 0, z: 10 + adjacencyMeters * 0.4 };
    const camera: VecXZ = { x: 0, z: 30 }; // far OUTWARD, same side as the player
    expect(exteriorWallOccludesPlayer({ outwardNormal: SOUTH, wallCenter, player, camera, adjacencyMeters })).toBe(false);
  });

  it('does NOT fade a wall the player is not adjacent to (player too far outside the band)', () => {
    const player: VecXZ = { x: 0, z: 10 + adjacencyMeters + 3 }; // beyond the adjacency band
    const camera: VecXZ = { x: 0, z: 4 };
    expect(exteriorWallOccludesPlayer({ outwardNormal: SOUTH, wallCenter, player, camera, adjacencyMeters })).toBe(false);
  });

  it('does NOT fade when the player is on the INWARD side (inside) — the occupied-building path owns that case', () => {
    const player: VecXZ = { x: 0, z: 8 }; // inward of the wall plane
    const camera: VecXZ = { x: 0, z: 4 };
    expect(exteriorWallOccludesPlayer({ outwardNormal: SOUTH, wallCenter, player, camera, adjacencyMeters })).toBe(false);
  });

  it('a degenerate (zero-length) normal never occludes', () => {
    expect(exteriorWallOccludesPlayer({ outwardNormal: { x: 0, z: 0 }, wallCenter, player: { x: 0, z: 11 }, camera: { x: 0, z: 4 }, adjacencyMeters })).toBe(false);
  });
});

describe('cutaway depth offset (B3 — reveal faces must not z-fight)', () => {
  const depth = resolveCutawayDepthSettings('desktop-high');

  it('biases fading roof + upper-wall faces back and draws them after the opaque base', () => {
    for (const kind of ['roof', 'upperWall'] as const) {
      const o = resolveCutawayDepthOffset(kind, depth);
      expect(o.polygonOffset).toBe(true);
      expect(o.polygonOffsetFactor).toBeGreaterThan(0);
      expect(o.renderOrder).toBeGreaterThan(0);
    }
  });

  it('lifts the upper wall off the base by a vertical inset (the coplanar seam), but not the roof', () => {
    expect(resolveCutawayDepthOffset('upperWall', depth).verticalInsetMeters).toBeGreaterThan(0);
    expect(resolveCutawayDepthOffset('roof', depth).verticalInsetMeters).toBe(0);
  });

  it('never biases the retained base/interior (they own the depth buffer)', () => {
    for (const kind of ['baseWall', 'interior'] as const) {
      const o = resolveCutawayDepthOffset(kind, depth);
      expect(o.polygonOffset).toBe(false);
      expect(o.renderOrder).toBe(0);
      expect(o.verticalInsetMeters).toBe(0);
    }
  });
});

describe('threat visual language (V20/V29)', () => {
  it('classifies by certainty: visible > heard > remembered > known > unknown', () => {
    expect(classifyThreat({ inLineOfSight: true, recentlyHeard: true, lastKnownStale: true, flaggedKnown: true })).toBe('visible');
    expect(classifyThreat({ inLineOfSight: false, recentlyHeard: true, lastKnownStale: true, flaggedKnown: true })).toBe('heard');
    expect(classifyThreat({ inLineOfSight: false, recentlyHeard: false, lastKnownStale: true, flaggedKnown: true })).toBe('remembered');
    expect(classifyThreat({ inLineOfSight: false, recentlyHeard: false, lastKnownStale: false, flaggedKnown: true })).toBe('known');
    expect(classifyThreat({ inLineOfSight: false, recentlyHeard: false, lastKnownStale: false, flaggedKnown: false })).toBe('unknown');
  });

  it('uses color-independent marker shapes (V29): visible at entity, heard/remembered at last-known', () => {
    expect(threatMarkerStyle('visible')).toMatchObject({ shape: 'solid', atEntity: true });
    expect(threatMarkerStyle('heard')).toMatchObject({ shape: 'ping', atEntity: false });
    expect(threatMarkerStyle('remembered')).toMatchObject({ shape: 'ghost', atEntity: false });
    expect(threatMarkerStyle('unknown').shape).toBe('none');
  });
});
