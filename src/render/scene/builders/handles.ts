// Shared scene-build handle structs. Builders (static construction) populate these and hand them to the
// per-frame systems that consume them — so no system has to reach back into a god-object (the BlockScene
// decomposition; see docs/REFACTOR-godfiles.md). Plain data only: no methods, explicit `| null` over `?` so
// `exactOptionalPropertyTypes` stays satisfied. Mutable fields (opacity, current) are annotated where systems
// write them.

import type { Object3D, Mesh, MeshStandardMaterial } from 'three';
import type { VecXZ } from '../../world/visibility';

/**
 * A roof / upper-wall surface that fades for the cutaway (V20/V58). Tagged with the `buildingIndex` that owns
 * it so ONLY the occupied building fades (per-building cutaway, V59); an upper-wall group also carries the
 * shared outward horizontal normal of its panels so the DIRECTIONAL cutaway (V58) fades only the side(s)
 * turned toward the camera. `outwardNormal` is null for the roof. `opacity` is mutated by the CutawaySystem.
 */
export interface FadeSurface {
  readonly object: Object3D;
  readonly material: MeshStandardMaterial;
  readonly kind: 'roof' | 'upperWall';
  readonly outwardNormal: VecXZ | null;
  readonly heightMeters: number;
  readonly buildingIndex: number;
  /** World-XZ centre of the surface (on the wall plane) — used by the OUTSIDE-WALL cutaway (V62). */
  readonly centerX: number;
  readonly centerZ: number;
  opacity: number;
}

/** A destructible wall-section's meshes, keyed by structural cell — hidden by the BreachSystem when breached. */
export interface SectionMesh {
  readonly cell: number;
  readonly objects: Object3D[];
}

/** A hinged door leaf — the DoorSystem eases `current` toward the sim's open/closed target each frame. */
export interface DoorLeaf {
  readonly navCell: number;
  readonly pivot: Object3D;
  readonly openTarget: number;
  current: number;
}

/** Player avatar handles. `rimMat` drives the accessibility outline glow; `aoContact` follows the player each
 *  frame (both null when disabled by config). */
export interface PlayerHandles {
  readonly mesh: Object3D;
  readonly rimMat: MeshStandardMaterial | null;
  readonly aoContact: Mesh | null;
}
