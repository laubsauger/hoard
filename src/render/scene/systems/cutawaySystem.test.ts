// CutawaySystem (highest-risk extraction): the X-RAY BUBBLE cutaway (V74). A faded surface drops depthWrite
// (V20 "blood invisible indoors") but KEEPS object.visible = true (V60 still casts shadows); motion reduction
// SNAPS the fade instead of easing it (V29); the bubble is RADIUS-SELECTIVE (far surfaces stay opaque) and now
// works behind ANY wall — a neighbour/exterior wall between the player and the camera fades regardless of which
// building the player occupies (the bug). Pure CPU — real Three meshes + real visibility settings + a fake runtime.

import { describe, it, expect } from 'vitest';
import { Mesh, MeshStandardMaterial, PerspectiveCamera } from 'three';
import { CutawaySystem, type CutawaySystemConfig } from './cutawaySystem';
import { resolveVisibilitySettings } from '../../world/visibility';
import type { GameRuntime } from '../../../game/runtime';
import type { FadeSurface } from '../builders/handles';

const TIER = 'desktop-high' as const;

function cfg(): CutawaySystemConfig {
  return { visibility: resolveVisibilitySettings(TIER), roofFadeSeconds: 0.2 };
}

// player at world (5,5).
function fakeRuntime(): GameRuntime {
  return { player: () => ({ x: 5, y: 0, z: 5 }) } as unknown as GameRuntime;
}

// A roof centred at (centerX, centerZ) with an 8×8-ish footprint half-extent (so a player at (5,5) is inside it).
function roof(centerX: number, centerZ: number): FadeSurface {
  const material = new MeshStandardMaterial({ transparent: true });
  return {
    object: new Mesh(undefined, material),
    material,
    kind: 'roof',
    outwardNormal: null,
    heightMeters: 6,
    buildingIndex: 0,
    centerX,
    centerZ,
    halfX: 4,
    halfZ: 4,
    opacity: 1,
  };
}

// A thin south-facing exterior upper-wall whose plane sits at z=czCenter (outward normal +z), spanning ~8 m in x.
function southWall(czCenter: number, buildingIndex: number): FadeSurface {
  const material = new MeshStandardMaterial({ transparent: true });
  return {
    object: new Mesh(undefined, material),
    material,
    kind: 'upperWall',
    outwardNormal: { x: 0, z: 1 },
    heightMeters: 3,
    buildingIndex,
    centerX: 5,
    centerZ: czCenter,
    halfX: 4,
    halfZ: 0.1,
    opacity: 1,
  };
}

// camera looking down at the player from +z+y so the player→camera direction is non-degenerate.
const camera = (() => {
  const c = new PerspectiveCamera();
  c.position.set(5, 40, 30);
  return c;
})();

describe('CutawaySystem (X-ray bubble V74)', () => {
  it('eases a roof open when the player is under it, dropping depthWrite while faded but keeping it visible (V20/V60)', () => {
    const s = roof(5, 5);
    const sys = new CutawaySystem([s], cfg());
    expect(s.material.depthWrite).toBe(true); // opaque to start

    for (let i = 0; i < 30; i++) sys.update(fakeRuntime(), camera, 1 / 30, false);

    expect(s.opacity).toBeLessThan(0.5); // roof faded to reveal the interior
    expect(s.material.opacity).toBe(s.opacity); // material mirrors the tracked opacity
    expect(s.material.depthWrite).toBe(false); // V20: faded surface stops writing depth
    expect(s.object.visible).toBe(true); // V60: still in the scene so it keeps casting shadows
  });

  it('eases toward the SLIVER min-opacity, never fully vanishing (V65)', () => {
    const s = roof(5, 5);
    const sys = new CutawaySystem([s], cfg());
    for (let i = 0; i < 600; i++) sys.update(fakeRuntime(), camera, 1 / 30, false);
    expect(s.opacity).toBeCloseTo(cfg().visibility.minOpacity, 2);
    expect(s.opacity).toBeGreaterThan(0); // a faint hint stays for orientation
  });

  it('SNAPS the fade under motion reduction instead of easing (V29)', () => {
    const s = roof(5, 5);
    const sys = new CutawaySystem([s], cfg());
    sys.update(fakeRuntime(), camera, 1 / 30, true); // a SINGLE frame with reduceMotion
    expect(s.opacity).toBeLessThan(0.99); // jumped straight to the faded target, not eased
    expect(s.material.depthWrite).toBe(false);
    expect(s.object.visible).toBe(true);
  });

  it('is RADIUS-SELECTIVE: a roof far outside the x-ray bubble stays opaque (the district reads solid)', () => {
    const near = roof(5, 5); // under the player
    const far = roof(100, 5); // a distant house, well beyond the bubble
    const sys = new CutawaySystem([near, far], cfg());
    for (let i = 0; i < 30; i++) sys.update(fakeRuntime(), camera, 1 / 30, false);
    expect(near.opacity).toBeLessThan(0.5);
    expect(far.opacity).toBeGreaterThan(0.95);
    expect(far.material.depthWrite).toBe(true); // opaque distant roof occludes normally
  });

  it('fades an UN-occupied building wall between the player and the camera within the bubble (the bug)', () => {
    // The player stands at (5,5); a neighbour wall sits at z=8 (between the player at z=5 and the camera at z=30),
    // a couple of metres away — the old per-building/hug gates left the player hidden behind it. buildingIndex 1
    // is NOT the building the player occupies, but the generic bubble fades it anyway.
    const wall = southWall(8, 1);
    const sys = new CutawaySystem([wall], cfg());
    for (let i = 0; i < 30; i++) sys.update(fakeRuntime(), camera, 1 / 30, false);
    expect(wall.opacity).toBeLessThan(0.5);
    expect(wall.material.depthWrite).toBe(false);
  });

  it('keeps a wall opaque when it is NOT between the player and the camera (far wall reads enclosure)', () => {
    // A wall at z=2 is on the SAME side as the player relative to the camera (both south of nothing): camera z=30,
    // player z=5, wall z=2 → player + camera are on the +side of the wall plane → not between → stays opaque.
    const wall = southWall(2, 0);
    const sys = new CutawaySystem([wall], cfg());
    for (let i = 0; i < 30; i++) sys.update(fakeRuntime(), camera, 1 / 30, false);
    expect(wall.opacity).toBeGreaterThan(0.95);
    expect(wall.material.depthWrite).toBe(true);
  });

  it('snaps to the opaque target at the construction prime (dt<=0, no camera)', () => {
    const s = roof(5, 5);
    s.opacity = 0.2; // pretend it was mid-fade
    const sys = new CutawaySystem([s], cfg());
    sys.update(fakeRuntime(), undefined, 0, false);
    expect(s.opacity).toBe(1); // no camera → stays opaque, snapped at dt<=0
    expect(s.material.depthWrite).toBe(true);
  });
});
