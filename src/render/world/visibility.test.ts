// T28 / V20 — occlusion decision: roof fades, base preserved, hidden interior stays hidden; threat language.

import { describe, it, expect } from 'vitest';
import {
  resolveVisibilitySettings,
  resolveSurfaceVisibility,
  resolveCutawayDepthSettings,
  resolveCutawayDepthOffset,
  wallFacesCamera,
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

  it('fades the roof when it encloses the room AND occludes the player view', () => {
    const v = resolveSurfaceVisibility('roof', ctx({ roomEnclosed: true, occludesPlayerView: true }), settings);
    expect(v.visible).toBe(false);
    expect(v.targetOpacity).toBe(0);
  });

  it('keeps the roof when it does not occlude the player view', () => {
    const v = resolveSurfaceVisibility('roof', ctx({ roomEnclosed: true, occludesPlayerView: false }), settings);
    expect(v.visible).toBe(true);
  });

  it('fades upper wall sections above the fade-start height when occluding, keeps base-band sections', () => {
    const high = resolveSurfaceVisibility('upperWall', ctx({ surfaceHeightMeters: 4, occludesPlayerView: true }), settings);
    expect(high.visible).toBe(false);
    const low = resolveSurfaceVisibility('upperWall', ctx({ surfaceHeightMeters: settings.baseHeightMeters - 0.1, occludesPlayerView: true }), settings);
    expect(low.visible).toBe(true);
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

  it('feeds the upperWall decision: a camera-facing wall fades, the far wall is kept', () => {
    const toCam: VecXZ = { x: 1, z: 0 };
    const near = resolveSurfaceVisibility('upperWall', ctx({ surfaceHeightMeters: 4, occludesPlayerView: faces(EAST, toCam) }), settings);
    const far = resolveSurfaceVisibility('upperWall', ctx({ surfaceHeightMeters: 4, occludesPlayerView: faces(WEST, toCam) }), settings);
    expect(near.visible).toBe(false);
    expect(far.visible).toBe(true);
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
