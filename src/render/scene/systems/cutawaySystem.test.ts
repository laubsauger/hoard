// CutawaySystem (highest-risk extraction): a faded surface drops depthWrite (V20 "blood invisible indoors")
// but KEEPS object.visible = true (V60 still casts shadows); motion reduction SNAPS the fade instead of easing
// it (V29); and ONLY the occupied building fades (V59 per-building) while neighbours stay opaque. Pure CPU —
// real Three meshes + real visibility settings + a fake runtime whose scene exposes the building bounds.

import { describe, it, expect } from 'vitest';
import { Mesh, MeshStandardMaterial, PerspectiveCamera } from 'three';
import { CutawaySystem, type CutawaySystemConfig } from './cutawaySystem';
import { resolveVisibilitySettings } from '../../world/visibility';
import type { GameRuntime } from '../../../game/runtime';
import type { FadeSurface } from '../builders/handles';

const TIER = 'desktop-high' as const;

function cfg(): CutawaySystemConfig {
  return { visibility: resolveVisibilitySettings(TIER), roofFadeSeconds: 0.2, navCellSize: 1 };
}

// player at cell (5,5); building 0 owns it, building 1 is the far neighbour.
function fakeRuntime(): GameRuntime {
  return {
    player: () => ({ x: 5, y: 0, z: 5 }),
    scene: {
      buildings: [
        { bounds: { minCx: 0, maxCx: 10, minCy: 0, maxCy: 10 } },
        { bounds: { minCx: 100, maxCx: 110, minCy: 0, maxCy: 10 } },
      ],
    },
  } as unknown as GameRuntime;
}

function roof(buildingIndex: number): FadeSurface {
  const material = new MeshStandardMaterial({ transparent: true });
  return {
    object: new Mesh(undefined, material),
    material,
    kind: 'roof',
    outwardNormal: null,
    heightMeters: 6,
    buildingIndex,
    centerX: 5,
    centerZ: 5,
    opacity: 1,
  };
}

// camera looking down at the player from +z+y so towardCamera is non-degenerate.
const camera = (() => {
  const c = new PerspectiveCamera();
  c.position.set(5, 40, 30);
  return c;
})();

describe('CutawaySystem', () => {
  it('eases the occupied roof open, dropping depthWrite while faded but keeping it visible (V20/V60)', () => {
    const s = roof(0);
    const sys = new CutawaySystem([s], cfg());
    expect(s.material.depthWrite).toBe(true); // opaque to start

    for (let i = 0; i < 30; i++) sys.update(fakeRuntime(), camera, 1 / 30, false);

    expect(s.opacity).toBeLessThan(0.5); // roof faded to reveal the interior
    expect(s.material.opacity).toBe(s.opacity); // material mirrors the tracked opacity
    expect(s.material.depthWrite).toBe(false); // V20: faded surface stops writing depth
    expect(s.object.visible).toBe(true); // V60: still in the scene so it keeps casting shadows
  });

  it('SNAPS the fade under motion reduction instead of easing (V29)', () => {
    const s = roof(0);
    const sys = new CutawaySystem([s], cfg());
    sys.update(fakeRuntime(), camera, 1 / 30, true); // a SINGLE frame with reduceMotion
    expect(s.opacity).toBeLessThan(0.99); // jumped straight to the faded target, not eased
    expect(s.material.depthWrite).toBe(false);
    expect(s.object.visible).toBe(true);
  });

  it('fades ONLY the occupied building — a neighbour roof stays opaque (V59)', () => {
    const occupied = roof(0);
    const neighbour = roof(1);
    const sys = new CutawaySystem([occupied, neighbour], cfg());
    for (let i = 0; i < 30; i++) sys.update(fakeRuntime(), camera, 1 / 30, false);
    expect(occupied.opacity).toBeLessThan(0.5);
    expect(neighbour.opacity).toBeGreaterThan(0.95);
    expect(neighbour.material.depthWrite).toBe(true); // opaque neighbour occludes normally
  });

  it('snaps to the opaque target at the construction prime (dt<=0, no camera)', () => {
    const s = roof(0);
    s.opacity = 0.2; // pretend it was mid-fade
    const sys = new CutawaySystem([s], cfg());
    sys.update(fakeRuntime(), undefined, 0, false);
    expect(s.opacity).toBe(1); // no camera → stays opaque, snapped at dt<=0
    expect(s.material.depthWrite).toBe(true);
  });
});
