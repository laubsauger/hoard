// T41 — GATE-0 test-block scene (authored content, not engine tuning).
// A two-room interior: room A (left) and room B (right) separated by a solid wall whose ONLY
// connection is a single destructible wall section (a StructuralModule). The player stands in room B;
// the horde spawns in room A. Until the wall is breached the rooms are navigationally disconnected —
// breaching it opens a route, which is the central promise (§G) made measurable.
//
// Geometry is authored level content (cell counts / wall positions), the way destruction.test.ts uses
// literal grid sizes. Genuinely-tunable values (population, spawn extent) are sourced from config by
// the caller and passed in, never hardcoded here (V4).

import { NavGrid } from '@/game/navigation';
import { RegionGraph } from '@/game/navigation';
import { StructuralModule } from '@/game/destruction';
import type { ModuleId } from '@/game/core/contracts';
import type { PlacedHouse } from './placeHouse';
import type { RoomType } from './houseTemplates';
import type { WindowPlacement } from './windows';

/** Base-package version this authored block belongs to (save-compat gate on reload — V23). */
export const TEST_BLOCK_WORLD_VERSION = 'gate0-testblock-1';

export const REGION_ROOM_A = 0;
export const REGION_ROOM_B = 1;

/** Authored layout (nav cells). The grid is two 20x20 rooms either side of a one-cell-thick wall. */
const GRID_WIDTH_CELLS = 41; // room A: cx 0..19 | wall: cx 20 | room B: cx 21..40
const GRID_HEIGHT_CELLS = 20;
const WALL_CX = 20;
/** The destructible wall section spans these rows; the rest of the wall column is permanent. */
const WALL_SECTION_CY_START = 8;
const WALL_SECTION_CELLS = 4; // cy 8,9,10,11
const TEST_MODULE_ID = 1 as ModuleId;
const FRACTURE_FAMILY = 0;

/** Player stands in room B; horde spawn-centre sits in room A. (cell coords) */
const PLAYER_CELL: CellXY = { cx: 31, cy: 10 };
const SPAWN_CENTER_CELL: CellXY = { cx: 9, cy: 10 };

export interface CellXY {
  readonly cx: number;
  readonly cy: number;
}

/** Inclusive cell rectangle of the building shell (walls + interior). Cells inside get a roof + cutaway;
 *  cells outside are open-air street. Used purely by the renderer (T38), never by the sim. */
export interface CellRect {
  readonly minCx: number;
  readonly maxCx: number;
  readonly minCy: number;
  readonly maxCy: number;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * One enterable building in a multi-building district (T80). `bounds` is the shell footprint (perimeter
 * walls + interior) in nav cells; the renderer gives EACH building its own roof + interior floor slab and
 * fades ONLY the building the player currently occupies (per-building cutaway, V20/V57). `storeys` scales
 * the wall/roof height (1 = single-storey, 2 = two-storey ~6 m). A district with a single building is just
 * the one-element case — every prior single-building scene keeps working through `buildingsOf` (below).
 */
export interface BuildingFootprint {
  readonly bounds: CellRect;
  /** Storeys (default 1). Wall height = world.buildingWallHeightMeters × storeys. */
  readonly storeys?: number;
}

/** Suburban ground paint (T80) — the renderer draws each as a flat coloured quad (asphalt street, concrete
 *  sidewalk, grass verge/yard). Pure presentation; never consulted by the sim. */
export type GroundKind = 'asphalt' | 'sidewalk' | 'grass';
export interface GroundRect {
  readonly kind: GroundKind;
  readonly rect: CellRect;
}

/** Decorative district dressing (T80) — abandoned cars, tires, bushes, trees, yard fences. The renderer
 *  builds simple shared geometry per kind at the cell centre; these do NOT block nav (kept out of the grid
 *  so they never render as full-height walls). `rot` is a Y-rotation (radians); `variant` tweaks size/tint. */
export type PropKind = 'car' | 'tire' | 'bush' | 'tree' | 'fence';
export interface PropInstance {
  readonly kind: PropKind;
  readonly cx: number;
  readonly cy: number;
  readonly rot?: number;
  readonly variant?: number;
}

export interface TestBlock {
  readonly navGrid: NavGrid;
  readonly region: RegionGraph;
  /** The single destructible wall section connecting room A <-> room B. */
  readonly wall: StructuralModule;
  readonly moduleId: ModuleId;
  readonly worldVersion: string;
  readonly fractureFamily: number;
  /** Player aim/eye position is filled per-runtime using player config aim height. */
  readonly playerCell: CellXY;
  readonly spawnCenterCell: CellXY;
  /** Union bounding box of all buildings (walls + interior) — back-compat single-rect accessor (T38). For a
   *  multi-building district this is the bbox covering every building; the renderer iterates `buildings`. */
  readonly buildingBounds: CellRect;
  /** Every enterable building in the district (T80). Absent/empty ⇒ the single-building case `[buildingBounds]`
   *  (see `buildingsOf`). The renderer gives each its own roof + floor + per-building cutaway. */
  readonly buildings?: readonly BuildingFootprint[];
  /** Suburban ground paint quads (asphalt/sidewalk/grass) the renderer draws over the base ground (T80). */
  readonly groundRects?: readonly GroundRect[];
  /** Decorative district dressing (cars/tires/bushes/trees/fences) the renderer instantiates (T80). */
  readonly props?: readonly PropInstance[];
  /** Walkable cells the player can leave/enter a building through (front doors, T38). May be empty. */
  readonly exitCells: readonly CellXY[];
  /** P0: the room-based houses generated from floor-plan templates (placeHouse). Present for the templated
   *  district; absent for the bare GATE-0 / M1 blocks. The renderer (P0c) builds walls/doors/windows from
   *  each house's `wallEdges`; loot/AI read rooms-as-regions via `roomAt`. */
  readonly placedHouses?: readonly PlacedHouse[];
  /** P0: the authored window set (derived from the placed templates). When present, `windowPlacements` returns
   *  THIS exact set so the sim seed + the renderer mesh build read the SAME windows (V26). */
  readonly windowSeeds?: readonly WindowPlacement[];
  /** P0 rooms-as-regions (cell → room): which house + room (and its type) a world cell belongs to, or null
   *  outside every house interior. For later loot/furniture/AI ("a zombie wanders its room"). */
  roomAt?(cx: number, cy: number): { readonly houseIndex: number; readonly roomId: number; readonly type: RoomType } | null;
  /** World-space centre of a nav cell (y = 0 floor). */
  cellCenter(cell: CellXY): Vec3;
  /** Map a module-local structural cell to the nav cell it occupies (integrator-owned seam). */
  navCellForStructuralCell(structuralCell: number): CellXY;
  /** Index into the nav cost grid for a cell. */
  navIndex(cell: CellXY): number;
  /** True when a world position lies on an in-bounds, walkable nav cell. */
  isWalkableWorld(x: number, z: number): boolean;
}

/**
 * Radius-aware walkability (T58/V42): a body of radius `r` may occupy (x,z) only if its centre AND its
 * four cardinal rim points are all walkable — so no part of the circle pokes into a wall/closed-door/
 * boarded/obstructed cell. Cheap 5-sample approximation; the integrator rejects or slides on failure so
 * bodies never clip half into a wall. Composes the scene's own `isWalkableWorld` (one source of truth).
 */
export function isWalkableRadius(
  scene: Pick<TestBlock, 'isWalkableWorld'>,
  x: number,
  z: number,
  r: number,
): boolean {
  return (
    scene.isWalkableWorld(x, z) &&
    scene.isWalkableWorld(x + r, z) &&
    scene.isWalkableWorld(x - r, z) &&
    scene.isWalkableWorld(x, z + r) &&
    scene.isWalkableWorld(x, z - r)
  );
}

/**
 * The buildings of a scene as a non-empty list (T80). Multi-building districts supply `buildings`; every
 * legacy single-building scene falls back to the one-element `[{ bounds: buildingBounds }]` so the renderer
 * has ONE code path. A building with no explicit storeys reads as single-storey at the configured height.
 */
export function buildingsOf(
  block: Pick<TestBlock, 'buildings' | 'buildingBounds'>,
): readonly BuildingFootprint[] {
  return block.buildings && block.buildings.length > 0
    ? block.buildings
    : [{ bounds: block.buildingBounds }];
}

/** Sample step (m) for the LOS walk — ~half a nav cell so a wall between two points is never skipped. */
const LOS_STEP_METERS = 1;

/**
 * True when the straight segment (x0,z0)→(x1,z1) crosses an interior EDGE-wall (a walled cell edge). Walks
 * the segment in fine sub-cell steps tracking the cell it is in; when it enters a new cell, the transition
 * is gated on `NavGrid.canStep` — a walled cardinal edge (or a corner-cut past a perpendicular edge-wall on
 * a diagonal transition) returns true. Cells stay walkable, so this is the cross-edge test that cell-blocking
 * (`isWalkableWorld`) cannot express. Out-of-bounds transitions are left to the cell-block test. Determinism
 * (V26): pure function of the grid + endpoints, no RNG, allocation-free.
 */
export function segmentCrossesWall(
  navGrid: NavGrid,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): boolean {
  const cs = navGrid.settings.navCellSize;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const dist = Math.hypot(dx, dz);
  if (dist === 0) return false;
  // quarter-cell steps: a sample never jumps more than one cell in either axis, so every crossed edge is seen.
  const steps = Math.max(1, Math.ceil(dist / (cs * 0.25)));
  let pcx = Math.floor(x0 / cs);
  let pcy = Math.floor(z0 / cs);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cx = Math.floor((x0 + dx * t) / cs);
    const cy = Math.floor((z0 + dz * t) / cs);
    if (cx === pcx && cy === pcy) continue;
    const sx = Math.sign(cx - pcx);
    const sy = Math.sign(cy - pcy);
    // only test the edge when BOTH cells are in bounds; exterior/boundary occlusion is cell-blocking's job.
    const fromIn = pcx >= 0 && pcy >= 0 && pcx < navGrid.width && pcy < navGrid.height;
    const toIn = cx >= 0 && cy >= 0 && cx < navGrid.width && cy < navGrid.height;
    if (fromIn && toIn && !navGrid.canStep(pcx, pcy, sx, sy)) return true;
    pcx = cx;
    pcy = cy;
  }
  return false;
}

/**
 * Line-of-sight (T68/V47): true when NO blocked cell lies on the segment between (x0,z0) and (x1,z1) — a
 * zombie cannot see the player through a wall/closed door. Endpoints are excluded so the observer's and
 * target's own cells never block. Walks the segment sampling the scene's `isWalkableWorld`.
 */
export function hasLineOfSight(
  scene: Pick<TestBlock, 'isWalkableWorld'> & Partial<Pick<TestBlock, 'navGrid'>>,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): boolean {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const dist = Math.hypot(dx, dz);
  // Interior partition (edge-wall) occlusion: a ray crossing a walled cell edge is blocked, so sight + sound
  // don't pass through interior walls (open doorways/windows still pass — those are clear edges/cells). The
  // narrow LOS mocks that expose only isWalkableWorld keep pure cell-occlusion (no navGrid → no edge test).
  if (scene.navGrid && segmentCrossesWall(scene.navGrid, x0, z0, x1, z1)) return false;
  const steps = Math.max(1, Math.ceil(dist / LOS_STEP_METERS));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!scene.isWalkableWorld(x0 + dx * t, z0 + dz * t)) return false;
  }
  return true;
}

/**
 * Distance (m) from (x,z) along `heading` until the first blocked cell, capped at `maxDist`. Used by the
 * debug overlay to crop a vision cone at walls. Returns `maxDist` if the ray stays clear.
 */
export function rayDistanceToWall(
  scene: Pick<TestBlock, 'isWalkableWorld'> & Partial<Pick<TestBlock, 'navGrid'>>,
  x: number,
  z: number,
  heading: number,
  maxDist: number,
): number {
  const dx = Math.cos(heading);
  const dz = Math.sin(heading);
  // Stop the ray at the first interior edge-wall it would cross too (an occluder), not just a blocked cell, so
  // the crop hugs partitions the way it hugs the sealed shell. Tracked incrementally (O(steps)) — the cell the
  // ray is in is remembered and the cross-edge is tested only on a cell transition. Edge-walls are tested only
  // when a navGrid is available (production always carries one; the narrow vision mocks keep cell-occlusion).
  const grid = scene.navGrid;
  const cs = grid ? grid.settings.navCellSize : 0;
  // sample finely enough that a cell transition is never skipped when edge-walls are in play (quarter cell).
  const stepM = grid ? Math.min(LOS_STEP_METERS, cs * 0.25) : LOS_STEP_METERS;
  const steps = Math.max(1, Math.ceil(maxDist / stepM));
  let pcx = grid ? Math.floor(x / cs) : 0;
  let pcy = grid ? Math.floor(z / cs) : 0;
  for (let i = 1; i <= steps; i++) {
    const d = (i / steps) * maxDist;
    const px = x + dx * d;
    const pz = z + dz * d;
    if (!scene.isWalkableWorld(px, pz)) return d;
    if (grid) {
      const cx = Math.floor(px / cs);
      const cy = Math.floor(pz / cs);
      if (cx !== pcx || cy !== pcy) {
        const sx = Math.sign(cx - pcx);
        const sy = Math.sign(cy - pcy);
        const fromIn = pcx >= 0 && pcy >= 0 && pcx < grid.width && pcy < grid.height;
        const toIn = cx >= 0 && cy >= 0 && cx < grid.width && cy < grid.height;
        if (fromIn && toIn && !grid.canStep(pcx, pcy, sx, sy)) return d;
        pcx = cx;
        pcy = cy;
      }
    }
  }
  return maxDist;
}

/**
 * Visibility FAN (T68/V47): cast `rays+1` rays fanned across a cone of half-angle `fovHalf` centred on
 * `heading` from (x,z), each clipped at the first wall (`rayDistanceToWall`). Returns the per-ray reach
 * distances — the DEFORMED visibility polygon (hugs walls), NOT a uniform cone scaled to one ray. The
 * shared primitive used by BOTH the perception logic (a target is seen iff inside this polygon) AND the
 * debug overlay (which builds its cone mesh from these distances), so they always agree.
 */
export function castVisibilityFan(
  scene: Pick<TestBlock, 'isWalkableWorld'> & Partial<Pick<TestBlock, 'navGrid'>>,
  x: number,
  z: number,
  heading: number,
  fovHalf: number,
  range: number,
  rays: number,
  out?: Float32Array,
): Float32Array {
  const n = Math.max(1, rays) + 1;
  const dist = out && out.length >= n ? out : new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = heading - fovHalf + (2 * fovHalf * i) / (n - 1);
    dist[i] = rayDistanceToWall(scene, x, z, a, range);
  }
  return dist;
}

/**
 * True when a target at (tx,tz) is inside the agent's deformed visibility fan from (x,z) — within range,
 * within the cone, AND not occluded by a wall on the direct ray (the same LOS the fan is built from). This
 * is the authoritative "can see" test the perception logic uses; it agrees with the fan overlay by
 * construction. (`fovHalf >= π` = omnidirectional, range-only + LOS.)
 */
export function seesWithinFan(
  scene: Pick<TestBlock, 'isWalkableWorld'> & Partial<Pick<TestBlock, 'navGrid'>>,
  x: number,
  z: number,
  heading: number,
  fovHalf: number,
  range: number,
  tx: number,
  tz: number,
): boolean {
  const dx = tx - x;
  const dz = tz - z;
  if (Math.hypot(dx, dz) > range) return false;
  if (fovHalf < Math.PI) {
    const diff = Math.atan2(dz, dx) - heading;
    if (Math.abs(Math.atan2(Math.sin(diff), Math.cos(diff))) > fovHalf) return false;
  }
  return hasLineOfSight(scene, x, z, tx, tz);
}

/**
 * Build a fresh BASE world (immutable authored geometry). Reload reconstructs this and re-applies the
 * compact delta on top (V9) — the base is never persisted, only re-built here.
 */
export function buildTestBlock(): TestBlock {
  const navGrid = new NavGrid({ width: GRID_WIDTH_CELLS, height: GRID_HEIGHT_CELLS });
  const region = new RegionGraph();
  region.addRegion(REGION_ROOM_A);
  region.addRegion(REGION_ROOM_B);

  // Solid dividing wall: block the whole wall column. The destructible section is part of this wall
  // and starts blocked too (intact). Breaching it later clears those cells (opens the route).
  for (let cy = 0; cy < GRID_HEIGHT_CELLS; cy++) {
    navGrid.block(WALL_CX, cy);
  }

  // The destructible wall section as a sparse StructuralModule: 1 wide (x), 1 tall (y), N deep (z).
  const wall = new StructuralModule({
    id: TEST_MODULE_ID,
    sizeX: 1,
    sizeY: 1,
    sizeZ: WALL_SECTION_CELLS,
    seed: 1337,
  });
  for (let z = 0; z < WALL_SECTION_CELLS; z++) {
    wall.addCell({ x: 0, y: 0, z, material: 'brick', family: FRACTURE_FAMILY, strength: 100 });
  }

  const navCellSize = navGrid.settings.navCellSize;

  const block: TestBlock = {
    navGrid,
    region,
    wall,
    moduleId: TEST_MODULE_ID,
    worldVersion: TEST_BLOCK_WORLD_VERSION,
    fractureFamily: FRACTURE_FAMILY,
    playerCell: PLAYER_CELL,
    spawnCenterCell: SPAWN_CENTER_CELL,
    // The bare GATE-0 block is wall-to-wall building: the whole grid is the shell, no street, no exit.
    buildingBounds: { minCx: 0, maxCx: GRID_WIDTH_CELLS - 1, minCy: 0, maxCy: GRID_HEIGHT_CELLS - 1 },
    exitCells: [],
    cellCenter: (cell) => ({
      x: (cell.cx + 0.5) * navCellSize,
      y: 0,
      z: (cell.cy + 0.5) * navCellSize,
    }),
    navCellForStructuralCell: (structuralCell) => {
      // module is 1x1xN so the local index IS the z row; map to the wall column + section offset.
      const { z } = wall.unpackCell(structuralCell);
      return { cx: WALL_CX, cy: WALL_SECTION_CY_START + z };
    },
    navIndex: (cell) => navGrid.index(cell.cx, cell.cy),
    isWalkableWorld: (x, z) => {
      const { cx, cy } = navGrid.worldToCell(x, z);
      if (cx < 0 || cy < 0 || cx >= navGrid.width || cy >= navGrid.height) return false;
      return !navGrid.isBlocked(navGrid.index(cx, cy));
    },
  };
  return block;
}
