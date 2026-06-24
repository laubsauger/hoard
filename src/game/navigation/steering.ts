// T11 — local steering grid.
// The shared flow field gives the coarse "which way to the target" vector (V15). Local steering
// refines it per-agent against immediate neighbours so a crowd can spread, queue and avoid local
// obstacles WITHOUT a unique collision-free route per agent (V19). This produces a desired heading;
// the collision broad-phase (T12) resolves the actual separation.

import type { FlowField } from './flowField';

export interface SteerInputs {
  /** Agent world position (x,z plane). */
  readonly x: number;
  readonly z: number;
  /** Neighbour offsets relative to the agent (already gathered by the collision broad-phase). */
  readonly neighbors: readonly { readonly dx: number; readonly dz: number }[];
  /** Separation radius — neighbours closer than this push back. */
  readonly separation: number;
  /** Weight of the flow-field direction vs separation, 0..1 (1 = pure flow). */
  readonly flowWeight: number;
}

export interface SteerResult {
  readonly dirX: number;
  readonly dirZ: number;
}

/** Combine the shared flow direction at the agent's cell with local separation from neighbours. */
export function steer(field: FlowField, input: SteerInputs): SteerResult {
  const { cx, cy } = field.grid.worldToCell(input.x, input.z);
  let flowX = 0;
  let flowZ = 0;
  if (cx >= 0 && cy >= 0 && cx < field.grid.width && cy < field.grid.height) {
    const cell = cy * field.grid.width + cx;
    if (field.isReachable(cell)) {
      const [fx, fz] = field.directionAt(cell);
      flowX = fx;
      flowZ = fz;
    }
  }
  return combineSteer(flowX, flowZ, input);
}

/**
 * Combine an ALREADY-RESOLVED flow direction (flowX, flowZ) with local separation from neighbours — the shared
 * core of `steer`. Exposed so the P3 multi-floor horde path can feed a flow vector sampled from a per-LEVEL
 * field (`LevelFlowField.directionAt(level, cell)`) through the SAME steering math the single-floor path uses,
 * with no behavioural drift. A zero (flowX,flowZ) yields pure separation.
 */
export function combineSteer(flowX: number, flowZ: number, input: SteerInputs): SteerResult {
  if (input.separation <= 0) throw new Error(`separation must be > 0, got ${input.separation}`);
  if (input.flowWeight < 0 || input.flowWeight > 1) throw new Error(`flowWeight must be in [0,1], got ${input.flowWeight}`);

  // Separation: sum repulsion from neighbours inside the separation radius.
  let sepX = 0;
  let sepZ = 0;
  for (const nb of input.neighbors) {
    const d = Math.hypot(nb.dx, nb.dz);
    if (d > 0 && d < input.separation) {
      const strength = (input.separation - d) / input.separation;
      sepX -= (nb.dx / d) * strength;
      sepZ -= (nb.dz / d) * strength;
    }
  }

  const w = input.flowWeight;
  let dx = flowX * w + sepX * (1 - w);
  let dz = flowZ * w + sepZ * (1 - w);
  const len = Math.hypot(dx, dz);
  if (len > 0) {
    dx /= len;
    dz /= len;
  }
  return { dirX: dx, dirZ: dz };
}
