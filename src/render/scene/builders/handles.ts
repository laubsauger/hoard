// Shared scene-build handle structs. Builders (static construction) populate these and hand them to the
// per-frame systems that consume them — so no system has to reach back into a god-object (the BlockScene
// decomposition; see docs/REFACTOR-godfiles.md). Plain data only: no methods, explicit `| null` over `?` so
// `exactOptionalPropertyTypes` stays satisfied. Mutable fields (opacity, current) are annotated where systems
// write them.

import type { Object3D, Mesh, Material } from 'three';
import type { VecXZ } from '../../world/visibility';
import type { PlayerAvatar } from '../../player';

/**
 * A roof / upper-wall surface that fades for the cutaway (V20/V58). Tagged with the `buildingIndex` that owns
 * it so ONLY the occupied building fades (per-building cutaway, V59); an upper-wall group also carries the
 * shared outward horizontal normal of its panels so the DIRECTIONAL cutaway (V58) fades only the side(s)
 * turned toward the camera. `outwardNormal` is null for the roof. `opacity` is mutated by the CutawaySystem.
 */
export interface FadeSurface {
  readonly object: Object3D;
  /** The CutawaySystem only mutates `opacity`/`depthWrite` (both on `Material`), so the wall siding can swap to a
   *  `MeshStandardNodeMaterial` (TSL cladding) while the roof stays a `MeshStandardMaterial` — both are `Material`. */
  readonly material: Material;
  readonly kind: 'roof' | 'upperWall';
  readonly outwardNormal: VecXZ | null;
  readonly heightMeters: number;
  readonly buildingIndex: number;
  /** World-XZ centre of the surface (on the wall plane / roof footprint centre). */
  readonly centerX: number;
  readonly centerZ: number;
  /** XZ half-extents of the surface's bounding box. The X-RAY BUBBLE cutaway (V74) measures its radius to the
   *  NEAREST point of this AABB, so a long wall fades when the player nears EITHER end and a player anywhere inside
   *  a large footprint still reveals its roof (nearest point = 0). */
  readonly halfX: number;
  readonly halfZ: number;
  opacity: number;
}

/** A destructible wall-section's meshes, keyed by structural cell — hidden by the BreachSystem when breached. */
export interface SectionMesh {
  readonly cell: number;
  readonly objects: Object3D[];
}

/** Static output of the house builder (per-building shell): the cutaway fade surfaces (upper walls + clapboard
 *  + roofs) and the destructible section meshes. Push order matches the build loop (blockScene.test asserts the
 *  fade-surface indices). Consumed per-frame by the cutaway + breach systems. */
export interface HouseHandles {
  readonly fadeSurfaces: FadeSurface[];
  readonly sectionMeshes: SectionMesh[];
}

/** A hinged door leaf — the DoorSystem eases `current` toward the sim's open/closed target each frame. */
export interface DoorLeaf {
  readonly navCell: number;
  readonly pivot: Object3D;
  readonly openTarget: number;
  current: number;
}

/** A window unit's child meshes (the frame is static; pane / dark void / boards toggle visibility), keyed by nav
 *  cell. The WindowSystem flips their visibility each frame to mirror the authoritative glass/board state (V12). */
export interface WindowMesh {
  readonly navCell: number;
  readonly pane: Mesh;
  readonly voidMesh: Mesh;
  readonly boards: Mesh[];
}

/** Static output of the openings builder (doors + windows): the hinged door leaves the DoorSystem swings and the
 *  window units the WindowSystem toggles. */
export interface OpeningHandles {
  readonly doorLeaves: DoorLeaf[];
  readonly windowMeshes: WindowMesh[];
}

/** Player avatar handles (T127). `avatar` owns the rigged SkinnedMesh + animation state machine (its `root`
 *  Group is positioned/faced each frame by BlockScene; the GLB swaps in async). `aoContact` is the cheap
 *  grounding disc that follows the player (null when disabled by config). The old capsule rim glow is dropped
 *  — a rigged mesh does not need the silhouette rim, so the accessibility outline-strength hook no longer
 *  scales a player material (it still drives every other outline; see V29). */
export interface PlayerHandles {
  readonly avatar: PlayerAvatar;
  readonly aoContact: Mesh | null;
}
