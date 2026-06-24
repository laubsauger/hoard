// T11 — local steering grid.
// The shared flow field gives the coarse "which way to the target" vector (V15). Local steering
// refines it per-agent against immediate neighbours so a crowd can spread, queue and avoid local
// obstacles WITHOUT a unique collision-free route per agent (V19). This produces a desired heading;
// the collision broad-phase (T12) resolves the actual separation.
//
// T134 — two ADDITIVE refinements so the body routes SMOOTHLY around walls/corners/furniture at its own
// size (V101): (1) the flow heading is BILINEARLY INTERPOLATED from the 4 nearest cells (was a single 2 m
// cell read → a 2 m-granular, zig-zaggy heading); (2) a cheap WALL-CLEARANCE repulsion sampled around the
// body at the agent radius biases the heading AWAY from nearby walls so a wide body keeps clearance + threads
// only the gaps it actually fits. Both are PURE functions of position + grid (no RNG, V26) and write into a
// reused scratch object so the per-tick hot path allocates nothing (V24).

import type { FlowField } from './flowField';
import type { NavGrid } from './navGrid';

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
  /** OPTIONAL (T134): probe distance (m) sampled around the body for nearby walls. 0/undefined ⇒ off. */
  readonly wallClearanceProbe?: number;
  /** OPTIONAL (T134): weight of the wall-repulsion vector blended into the heading (like separation).
   *  0/undefined ⇒ no wall clearance (back-compat: the bare flow+separation steer). */
  readonly wallClearanceWeight?: number;
  /**
   * OPTIONAL (T136): per-agent "give corners a wide berth" factor in [0, 1] — a STABLE per-zombie value. It
   * scales ONLY the wall-clearance weight up (never below the safe baseline), so a body with a high bias swings
   * WIDE around a wall corner (it goes AROUND) while a low-bias body takes the tight line (it cuts close) — the
   * organic spread that stops a whole horde funnelling through the exact same diagonal shortcut past a house
   * corner. No effect away from walls (the clearance vector is zero there) → open-ground movement is unchanged.
   * 0/undefined ⇒ the plain T134 clearance.
   */
  readonly cornerBias?: number;
}

export interface SteerResult {
  readonly dirX: number;
  readonly dirZ: number;
}

/** A 2-vector — the shape both flow-sampling helpers write into (a reusable scratch in the hot path). */
export interface Vec2 {
  x: number;
  z: number;
}

/** Module scratch so the hot path allocates nothing (V24). Single-threaded sim → safe to reuse per call. */
const FLOW_SCRATCH: Vec2 = { x: 0, z: 0 };
const CLEARANCE_SCRATCH: Vec2 = { x: 0, z: 0 };

/** T136: how much a max (1.0) per-zombie cornerBias widens the wall-clearance weight — at 1.0 a high-bias body
 *  gives corners up to ~2× the baseline berth (swings AROUND), a 0-bias body keeps the tight baseline line. */
const CORNER_CLEARANCE_SPREAD = 1;

/**
 * Scale a body's wall-clearance weight by its per-zombie cornerBias (T136). Only ever WIDENS the berth (never
 * below the baseline), so a high-bias body rounds a wall corner while a 0-bias body cuts the tight line. The
 * single place the spread lives, so the single-floor `steer` and the multi-floor `combineSteer` path agree.
 */
export function cornerBiasedWallWeight(wallWeight: number, cornerBias: number): number {
  return wallWeight * (1 + Math.max(0, cornerBias) * CORNER_CLEARANCE_SPREAD);
}

/**
 * BILINEARLY interpolate the flow direction at a CONTINUOUS world position from the 4 nearest cell directions
 * (T134/V101). The flow field stores one direction per 2 m cell; reading only the body's own cell gives a
 * heading that JUMPS at every cell boundary (the coarse zig-zag the player complained about). Sampling the 4
 * cells whose CENTRES bracket (wx,wz) and weighting by the sub-cell position yields a smooth continuous
 * heading. Out-of-bounds / unreachable corners are skipped and the remaining weight renormalised, so the blend
 * near a wall is naturally pulled toward the open cells. If NO corner is reachable (an unreachable pocket) it
 * falls back to the body's own cell direction — exactly the pre-interpolation behaviour. Writes into `out`
 * (default the module scratch) → allocation-free (V24). Pure fn of field + position (V26).
 *
 * Cell centres sit at INTEGER cell coords in this space: `g = world/cellSize - 0.5` maps a cell centre to its
 * integer index, so at a cell centre the blend collapses onto that one cell (the interpolation is identity).
 */
export function sampleFlowDirection(field: FlowField, wx: number, wz: number, out: Vec2 = FLOW_SCRATCH): Vec2 {
  const grid = field.grid;
  const cs = grid.settings.navCellSize;
  const w = grid.width;
  const h = grid.height;
  const gx = wx / cs - 0.5;
  const gy = wz / cs - 0.5;
  const cx0 = Math.floor(gx);
  const cy0 = Math.floor(gy);
  const fx = gx - cx0;
  const fy = gy - cy0;
  let ax = 0;
  let az = 0;
  let wsum = 0;
  for (let j = 0; j < 2; j++) {
    const cy = cy0 + j;
    if (cy < 0 || cy >= h) continue;
    const wyj = j === 0 ? 1 - fy : fy;
    if (wyj <= 0) continue;
    for (let i = 0; i < 2; i++) {
      const cx = cx0 + i;
      if (cx < 0 || cx >= w) continue;
      const weight = (i === 0 ? 1 - fx : fx) * wyj;
      if (weight <= 0) continue;
      const cell = cy * w + cx;
      if (!field.isReachable(cell)) continue; // skip blocked / unreachable corners; renormalise over the rest
      ax += field.dir[cell * 2]! * weight;
      az += field.dir[cell * 2 + 1]! * weight;
      wsum += weight;
    }
  }
  if (wsum > 0) {
    out.x = ax / wsum;
    out.z = az / wsum;
    return out;
  }
  // No reachable corner. Try the body's own cell direction (the coarse pre-interpolation heading) so the body
  // still gets a heading in an otherwise-reachable spot.
  out.x = 0;
  out.z = 0;
  const bx = Math.floor(wx / cs);
  const by = Math.floor(wz / cs);
  if (bx >= 0 && by >= 0 && bx < w && by < h) {
    const cell = by * w + bx;
    if (field.isReachable(cell)) {
      out.x = field.dir[cell * 2]!;
      out.z = field.dir[cell * 2 + 1]!;
      return out;
    }
  }
  // The body sits in a region the field NEVER reached — e.g. an outside zombie alerted by gunfire to a target
  // SEALED behind walls (a closed/boarded house). It can't know the exact source, so it BEELINES toward the
  // target's world position to investigate the AREA; the radius-collision + stuck-escape then wall-follow it
  // AROUND the structure to the nearest point it can reach (the doorway, the perimeter) instead of freezing in
  // place "not knowing where to go" (T134/V101). Pure fn of the field + position (V26).
  const bxv = ((field.targetCell % w) + 0.5) * cs - wx;
  const bzv = (Math.floor(field.targetCell / w) + 0.5) * cs - wz;
  const bl = Math.hypot(bxv, bzv);
  if (bl > 0) {
    out.x = bxv / bl;
    out.z = bzv / bl;
  }
  return out;
}

/** 8 unit probe directions (cardinal + normalised diagonal) — a fixed set, no per-call allocation (V24). */
const INV_SQRT2 = 1 / Math.SQRT2;
const CLEARANCE_DIRS: readonly { ux: number; uz: number }[] = [
  { ux: 1, uz: 0 },
  { ux: -1, uz: 0 },
  { ux: 0, uz: 1 },
  { ux: 0, uz: -1 },
  { ux: INV_SQRT2, uz: INV_SQRT2 },
  { ux: INV_SQRT2, uz: -INV_SQRT2 },
  { ux: -INV_SQRT2, uz: INV_SQRT2 },
  { ux: -INV_SQRT2, uz: -INV_SQRT2 },
];

/**
 * Cheap WALL-CLEARANCE repulsion (T134/V101): probe 8 directions a `probeDist` ring around the body; every
 * probe that lands on a blocked cell, off-grid, or across a walled cell EDGE (a thin wall) pushes the body
 * AWAY from that direction. The summed vector keeps a wide body off walls so it threads only the gaps it
 * actually fits + stops the path hugging into a pocket the agent radius can't clear. Magnitude scales with how
 * boxed-in the body is (more blocked probes ⇒ stronger push). Pure fn of grid + position (V26); writes `out`
 * (allocation-free, V24). `probeDist <= 0` ⇒ a zero vector (off).
 */
export function wallClearanceBias(grid: NavGrid, wx: number, wz: number, probeDist: number, out: Vec2 = CLEARANCE_SCRATCH): Vec2 {
  out.x = 0;
  out.z = 0;
  if (probeDist <= 0) return out;
  const cs = grid.settings.navCellSize;
  const w = grid.width;
  const h = grid.height;
  const bcx = Math.floor(wx / cs);
  const bcy = Math.floor(wz / cs);
  const bodyIn = bcx >= 0 && bcy >= 0 && bcx < w && bcy < h;
  let rx = 0;
  let rz = 0;
  for (const d of CLEARANCE_DIRS) {
    const px = wx + d.ux * probeDist;
    const pz = wz + d.uz * probeDist;
    const pcx = Math.floor(px / cs);
    const pcy = Math.floor(pz / cs);
    let blocked: boolean;
    if (pcx < 0 || pcy < 0 || pcx >= w || pcy >= h) {
      blocked = true; // off-grid is the sealed exterior — a hard wall
    } else if (grid.isBlocked(pcy * w + pcx)) {
      blocked = true; // a blocked cell (wall / solid furniture)
    } else if (bodyIn && (pcx !== bcx || pcy !== bcy)) {
      blocked = !grid.canStep(bcx, bcy, Math.sign(pcx - bcx), Math.sign(pcy - bcy)); // walled thin-wall edge
    } else {
      blocked = false;
    }
    if (blocked) {
      rx -= d.ux;
      rz -= d.uz;
    }
  }
  out.x = rx;
  out.z = rz;
  return out;
}

/**
 * Combine the shared flow direction at the agent's position with local separation from neighbours. The flow
 * heading is BILINEARLY interpolated (T134) for a smooth continuous direction, then — when `wallClearanceWeight`
 * is supplied — biased away from nearby walls. Falls through to the shared `combineSteer` core.
 */
export function steer(field: FlowField, input: SteerInputs): SteerResult {
  const flow = sampleFlowDirection(field, input.x, input.z, FLOW_SCRATCH);
  let flowX = flow.x;
  let flowZ = flow.z;
  // Normalise the interpolated heading to unit length so `flowWeight` keeps its meaning (each per-cell dir is
  // unit; a sub-cell blend of disagreeing dirs is shorter). A zero blend (unreachable spot) stays zero.
  const fl = Math.hypot(flowX, flowZ);
  if (fl > 0) {
    flowX /= fl;
    flowZ /= fl;
  }
  let wallX = 0;
  let wallZ = 0;
  // T136: a high per-zombie cornerBias widens the wall berth (the body rounds the corner) — never narrows it
  // below the T134 baseline, so it can't make a body clip a wall. Zero away from walls (wb is zero there).
  const wallWeight = cornerBiasedWallWeight(input.wallClearanceWeight ?? 0, input.cornerBias ?? 0);
  const probe = input.wallClearanceProbe ?? 0;
  if (wallWeight > 0 && probe > 0) {
    const wb = wallClearanceBias(field.grid, input.x, input.z, probe, CLEARANCE_SCRATCH);
    wallX = wb.x;
    wallZ = wb.z;
  }
  return combineSteer(flowX, flowZ, input, wallX, wallZ, wallWeight);
}

/**
 * Combine an ALREADY-RESOLVED flow direction (flowX, flowZ) with local separation from neighbours — the shared
 * core of `steer`. Exposed so the P3 multi-floor horde path can feed a flow vector sampled from a per-LEVEL
 * field (`LevelFlowField.directionAt(level, cell)`) through the SAME steering math the single-floor path uses,
 * with no behavioural drift. A zero (flowX,flowZ) yields pure separation. The optional `wallBias*`/`wallWeight`
 * (T134) add a wall-clearance repulsion term; omitted (default 0) ⇒ the original flow+separation blend.
 */
export function combineSteer(
  flowX: number,
  flowZ: number,
  input: SteerInputs,
  wallBiasX = 0,
  wallBiasZ = 0,
  wallWeight = 0,
): SteerResult {
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
  let dx = flowX * w + sepX * (1 - w) + wallBiasX * wallWeight;
  let dz = flowZ * w + sepZ * (1 - w) + wallBiasZ * wallWeight;
  const len = Math.hypot(dx, dz);
  if (len > 0) {
    dx /= len;
    dz /= len;
  }
  return { dirX: dx, dirZ: dz };
}
