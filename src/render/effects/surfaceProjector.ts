// T77 / V54 — render-side, READ-ONLY surface projector for the pooled blood system. Wraps a THREE.Raycaster
// over the STATIC structure meshes (street + interior floor slabs + walls + roof) so a landing blood droplet
// is placed on the REAL surface: the true floor height (interior slabs sit above the street — the indoors
// fix) oriented to its normal, or a wall behind a struck body for a vertical splat. Pure render concern (V2):
// it only reads scene geometry, never feeds the sim. Raycasts are bounded by the caller (BloodSim casts at
// most one floor + one wall ray per blood-spray event, never per droplet per frame).
//
// The projector is given an EXPLICIT list of structure meshes (assembled in GameViewport by excluding the
// crowd / player / gore / effect / gizmo objects), so the crowd and dynamic objects are never hit.

import { Raycaster, Vector3, type Object3D } from 'three';
import type { SurfaceProjector, SurfaceHit } from './bloodView';

const DOWN = new Vector3(0, -1, 0);
const FLOOR_PROBE_DROP_METERS = 6; // how far below the impact height a floor probe reaches (covers slab→street)

export class RaycastSurfaceProjector implements SurfaceProjector {
  private readonly ray = new Raycaster();
  private readonly origin = new Vector3();
  private readonly dir = new Vector3();
  private readonly nrm = new Vector3();

  /** @param structures the static structure meshes to test (floors/walls/roof) — caller excludes everything dynamic. */
  constructor(private readonly structures: readonly Object3D[]) {}

  floorBelow(x: number, fromY: number, z: number): SurfaceHit | null {
    if (this.structures.length === 0) return null;
    // Cast DOWN from the impact height (below the roof) so we find the floor/slab the body stands on, not
    // the roof above it. The nearest hit below the start wins (intersectObjects sorts ascending).
    this.origin.set(x, fromY, z);
    this.ray.set(this.origin, DOWN);
    this.ray.near = 0;
    this.ray.far = fromY + FLOOR_PROBE_DROP_METERS;
    return this.firstSurface();
  }

  wallAlong(x: number, y: number, z: number, dirX: number, dirZ: number, maxDist: number): SurfaceHit | null {
    if (this.structures.length === 0 || maxDist <= 0) return null;
    this.dir.set(dirX, 0, dirZ);
    if (this.dir.lengthSq() < 1e-8) return null;
    this.dir.normalize();
    this.origin.set(x, y, z);
    this.ray.set(this.origin, this.dir);
    this.ray.near = 0;
    this.ray.far = maxDist;
    return this.firstSurface();
  }

  /** Nearest intersection that carries a face normal, returned in WORLD space. */
  private firstSurface(): SurfaceHit | null {
    const hits = this.ray.intersectObjects(this.structures, false);
    for (const h of hits) {
      if (!h.face) continue;
      this.nrm.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
      return { x: h.point.x, y: h.point.y, z: h.point.z, nx: this.nrm.x, ny: this.nrm.y, nz: this.nrm.z };
    }
    return null;
  }
}
