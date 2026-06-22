// T12 / V6 — explicit collision layers.
// V6: navigation, collision, visual mesh, interaction geometry are NEVER merged. Within collision,
// distinct concerns get distinct layers so a query for one (e.g. movement) never accidentally
// matches another (e.g. sight). Layers are a bitmask so an agent can belong to several at once.

export enum CollisionLayer {
  Movement = 1 << 0,
  Projectile = 1 << 1,
  Attack = 1 << 2,
  Interaction = 1 << 3,
  Sight = 1 << 4,
  Audio = 1 << 5,
}

export const ALL_COLLISION_LAYERS: readonly CollisionLayer[] = [
  CollisionLayer.Movement,
  CollisionLayer.Projectile,
  CollisionLayer.Attack,
  CollisionLayer.Interaction,
  CollisionLayer.Sight,
  CollisionLayer.Audio,
];

/** Compose a mask from one or more layers. */
export function layerMask(...layers: CollisionLayer[]): number {
  let m = 0;
  for (const l of layers) m |= l;
  return m;
}

/** True when two masks share at least one layer. */
export function layersOverlap(a: number, b: number): boolean {
  return (a & b) !== 0;
}
