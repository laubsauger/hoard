// B4 / V19 — hard min-spacing penetration resolution.
// The crowd steering integrate only applies SOFT separation (a steering blend), so visible-tier agents
// can still interpenetrate. This pure relaxation pass pushes overlapping pairs apart to at least their
// configured min spacing AFTER integrate. It is body-radius scaled (not larger) so doorway queueing /
// compression still flows; callers exempt the abstract tier so a compressed off-screen horde may overlap.
//
// Pure + node-testable: it mutates only the provided agents' x/z, takes neighbour lookup and the
// walkable predicate as injected dependencies, and never touches the spatial hash or SoA store itself.

/** Below this centre distance two agents are treated as coincident and separated on a deterministic axis. */
const COINCIDENT_EPSILON = 1e-6;

/** A mutable planar body the resolver may push apart. `id` is a stable identity used for determinism. */
export interface SeparationAgent {
  readonly id: number;
  x: number;
  z: number;
  readonly radius: number;
}

export interface SeparationParams {
  /** Relaxation passes to run. 0 = no resolution. */
  readonly iterations: number;
  /** Min centre spacing as a multiple of the two agents' summed radii (1 = bodies just touch). */
  readonly minSpacingScale: number;
}

/** Returns the neighbouring agents to test `agent` against (already layer/tier filtered by the caller). */
export type NeighborQuery = (agent: SeparationAgent) => Iterable<SeparationAgent>;

/** Authoritative walkable test (world XZ). A push is only applied when its result stays walkable. */
export type WalkableTest = (x: number, z: number) => boolean;

/**
 * Push overlapping pairs apart to at least their min spacing, in place.
 *
 * Symmetric resolve: each agent applies HALF the needed correction relative to each neighbour; because
 * the neighbour applies its own half in its own turn, a pair converges to the min spacing over the
 * iterations. The walkable predicate stays authoritative — a correction that would leave an agent on a
 * non-walkable position is rejected (the agent keeps its prior, walkable position), so resolution never
 * pushes a body through a wall (clamp to walkable). Returns the set of agent ids whose position moved
 * so the caller can re-bucket exactly those in its spatial hash.
 */
export function resolveSeparation(
  agents: readonly SeparationAgent[],
  neighborsOf: NeighborQuery,
  isWalkable: WalkableTest,
  params: SeparationParams,
): Set<number> {
  if (!Number.isInteger(params.iterations) || params.iterations < 0) {
    throw new Error(`separation iterations must be a non-negative integer, got ${params.iterations}`);
  }
  if (!(params.minSpacingScale > 0)) {
    throw new Error(`minSpacingScale must be > 0, got ${params.minSpacingScale}`);
  }
  const moved = new Set<number>();
  for (let iter = 0; iter < params.iterations; iter++) {
    for (const a of agents) {
      let pushX = 0;
      let pushZ = 0;
      for (const b of neighborsOf(a)) {
        if (b.id === a.id) continue;
        const minDist = params.minSpacingScale * (a.radius + b.radius);
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        let dist = Math.hypot(dx, dz);
        if (dist >= minDist) continue;
        let nx: number;
        let nz: number;
        if (dist > COINCIDENT_EPSILON) {
          nx = dx / dist;
          nz = dz / dist;
        } else {
          // Coincident bodies: separate on a deterministic axis keyed on id so the result is stable.
          nx = a.id < b.id ? 1 : -1;
          nz = 0;
          dist = 0;
        }
        const halfCorrection = (minDist - dist) * 0.5;
        pushX += nx * halfCorrection;
        pushZ += nz * halfCorrection;
      }
      if (pushX === 0 && pushZ === 0) continue;
      const candX = a.x + pushX;
      const candZ = a.z + pushZ;
      // Walkable stays authoritative: only commit the push if it lands on a walkable cell (V19 clamp).
      if (isWalkable(candX, candZ)) {
        a.x = candX;
        a.z = candZ;
        moved.add(a.id);
      }
    }
  }
  return moved;
}
