// T77 / V54 — RaycastSurfaceProjector: the render-side, read-only projector that places landing blood on the
// REAL scene structure. THREE.Raycaster is CPU-only, so we exercise it against plain meshes without a GPU.

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';
import { RaycastSurfaceProjector } from './surfaceProjector';

/** A horizontal floor slab at height y (a rotated plane, like the interior floor in blockScene). */
function floorAt(y: number): Mesh {
  const m = new Mesh(new PlaneGeometry(20, 20), new MeshBasicMaterial());
  m.rotation.x = -Math.PI / 2; // face up (+Y)
  m.position.set(0, y, 0);
  m.updateMatrixWorld(true);
  return m;
}

/** A thin vertical wall slab centred at x, facing ∓X. */
function wallAt(x: number): Mesh {
  const m = new Mesh(new BoxGeometry(0.25, 4, 10), new MeshBasicMaterial());
  m.position.set(x, 2, 0);
  m.updateMatrixWorld(true);
  return m;
}

describe('RaycastSurfaceProjector (T77/V54)', () => {
  it('floorBelow picks the interior slab height (cast from the impact height, not the sky) + up normal', () => {
    // Street ground at 0 AND an interior slab at 0.2 above it — the slab must win for a body standing on it.
    const proj = new RaycastSurfaceProjector([floorAt(0), floorAt(0.2)]);
    const hit = proj.floorBelow(1, 1.1 /* torso impact height */, 1);
    expect(hit).not.toBeNull();
    expect(hit!.y).toBeCloseTo(0.2, 5); // the nearest surface below the impact, i.e. the raised slab
    expect(hit!.ny).toBeCloseTo(1, 5); // flat, normal up
  });

  it('floorBelow does NOT return the roof above the impact', () => {
    // A roof high above + the floor below: casting DOWN from the impact only sees the floor.
    const proj = new RaycastSurfaceProjector([floorAt(0), floorAt(3) /* roof */]);
    const hit = proj.floorBelow(0, 1.1, 0);
    expect(hit!.y).toBeCloseTo(0, 5);
  });

  it('wallAlong finds the wall down-range with a horizontal normal', () => {
    const proj = new RaycastSurfaceProjector([wallAt(2.5)]);
    const hit = proj.wallAlong(0, 1.1, 0, 1, 0, 5); // aim +x toward the wall
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(2.375, 2); // near the −x face of the 0.25-thick wall
    expect(Math.abs(hit!.ny)).toBeLessThan(0.5); // vertical surface → horizontal normal
    expect(Math.abs(hit!.nx)).toBeCloseTo(1, 5);
  });

  it('wallAlong returns null when no wall is within reach', () => {
    const proj = new RaycastSurfaceProjector([wallAt(20)]);
    expect(proj.wallAlong(0, 1.1, 0, 1, 0, 3)).toBeNull();
  });

  it('returns null with no structures (open ground — sim falls back to the base floor)', () => {
    const proj = new RaycastSurfaceProjector([]);
    expect(proj.floorBelow(0, 1, 0)).toBeNull();
    expect(proj.wallAlong(0, 1, 0, 1, 0, 5)).toBeNull();
  });
});
