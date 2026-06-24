// T12 — collision broad-phase barrel.

export {
  CollisionLayer,
  ALL_COLLISION_LAYERS,
  layerMask,
  layersOverlap,
} from './layers';
export {
  SpatialHash,
  type Agent,
  type SpatialHashOptions,
  type CollisionSettings,
} from './spatialHash';
export {
  resolveSeparation,
  type SeparationAgent,
  type SeparationParams,
  type NeighborQuery,
  type MoveTest,
} from './separation';
