// T28 / V20 — occlusion decision: roof fades, base preserved, hidden interior stays hidden; threat language.

import { describe, it, expect } from 'vitest';
import {
  resolveVisibilitySettings,
  resolveSurfaceVisibility,
  classifyThreat,
  threatMarkerStyle,
  type OcclusionContext,
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
