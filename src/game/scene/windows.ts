// T108 — authoritative WINDOW state system (additive; reads the nav grid, never mutates it).
//
// Windows are framed openings on a deterministic subset of building FACADE cells (the same cells the
// renderer dresses, T70/T87). Each window keeps a glass state (intact | open | smashed) + a board count.
// A window cell stays a BLOCKED wall cell in the nav grid at ALL times — windows deliberately do NOT change
// nav passability, because room A is sealed until the §G destructible wall is breached (V5/§G); turning a
// perimeter window into a walk-through opening would unseal room A via the street and break that invariant.
// What a window DOES govern: PROJECTILE OCCLUSION (an opening lets a shot pass; an intact pane shatters when
// hit), the rendered mesh (syncWindows), and the interaction verbs. State changes are driven by commands +
// the zombie-attrition tick (V12) — the renderer only REFLECTS the state, it never mutates it. The INITIAL
// state is derived from the house seed so a window that starts boarded/smashed in the render matches the sim
// (windowPlacements is the single source both the sim seed and the renderer mesh build consume).

import type { NavGrid } from '@/game/navigation';
import { buildingsOf, type TestBlock } from './testBlock';
import {
  authorHouseStyle,
  windowState,
  type HouseStyle,
  type HouseVariationParams,
  type WindowState,
} from './houseStyle';

/** A window's glass state. `open` = authored glassless from the start; `smashed` = a once-intact pane
 *  broken by a shot or a clawing zombie. Both are OPENINGS (functionally identical for passability). */
export type WindowGlass = 'intact' | 'open' | 'smashed';

/** A placed window: its nav cell, world centre, orientation + the authored decay state. The single source
 *  the sim seeds from AND the renderer builds meshes from, so they always agree (V26). */
export interface WindowPlacement {
  readonly cx: number;
  readonly cy: number;
  /** Wall runs along Z (cell sits on a min/max-cy facade) → the renderer rotates the window mesh. */
  readonly ns: boolean;
  /** Window index within its building (the seed-derived state key). */
  readonly slot: number;
  /** Authored decay state from the house seed (intact glass / smashed-open / boarded). */
  readonly state: WindowState;
  /** Storeys of the owning building (the renderer stacks a second-floor sill on a two-storey house). */
  readonly storeys: number;
  /** World-plane centre of the window cell. */
  readonly x: number;
  readonly z: number;
}

/** A live window view for the renderer (mesh swap) + interaction resolution. */
export interface WindowView {
  readonly cx: number;
  readonly cy: number;
  readonly x: number;
  readonly z: number;
  readonly glass: WindowGlass;
  readonly boards: number;
}

/** Tunables the window state system needs (from the structures config domain). */
export interface WindowSystemConfig {
  /** Max boards a single window can hold (a full board-up). */
  readonly maxBoards: number;
  /** Shots a pane absorbs before it smashes (≈1 — one bullet shatters glass). */
  readonly glassShotsToSmash: number;
  /** Zombie attack ticks to tear one board off a boarded window. */
  readonly ticksToBreakBoard: number;
  /** Zombie attack ticks to smash an intact pane once the boards are gone. */
  readonly ticksToSmashGlass: number;
}

/** The scene fields window placement needs — a narrow slice so it stays unit-testable without a runtime. */
type WindowScene = Pick<
  TestBlock,
  'navGrid' | 'buildings' | 'buildingBounds' | 'exitCells' | 'wall' | 'navCellForStructuralCell'
> & {
  /** P0: when the scene authored its windows from floor-plan templates, this IS the window set (V26). */
  readonly windowSeeds?: readonly WindowPlacement[];
};

/**
 * Which building (if any) owns the destructible §G section cells — the renderer keeps it lightly weathered
 * + un-collapsed so its interior stays readable. Mirrors blockScene.computeFeatureBuildingIndex so the sim
 * derives the same per-house damage (and therefore the same window decay) the renderer does.
 */
export function featureBuildingIndexOf(scene: WindowScene): number {
  const buildings = buildingsOf(scene);
  for (let z = 0; z < scene.wall.sizeZ; z++) {
    const cell = scene.navCellForStructuralCell(scene.wall.packCell(0, 0, z));
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i]!.bounds;
      if (cell.cx >= b.minCx && cell.cx <= b.maxCx && cell.cy >= b.minCy && cell.cy <= b.maxCy) return i;
    }
  }
  return -1;
}

/**
 * The replay-stable HouseStyle of a building (V26): seeded off the building's STABLE footprint, with the §G
 * feature house kept lightly weathered (clean tint, damped damage, no collapse). Pure — the renderer
 * (blockScene.styleFor) delegates here so the sim + render derive the SAME seed/damage, hence the SAME
 * window decay. Only seed + damage + storeys feed window placement; the colour fields ride along for render.
 */
export function houseStyleForBuilding(
  bounds: { minCx: number; minCy: number; maxCx: number; maxCy: number },
  storeysOverride: number | undefined,
  bi: number,
  houseVar: HouseVariationParams,
  featureBuildingIndex: number,
): HouseStyle {
  const seed =
    (Math.imul(bounds.minCx + 1, 73856093) ^ Math.imul(bounds.minCy + 1, 19349663) ^ Math.imul(bi + 1, 83492791)) | 0;
  const base = authorHouseStyle(seed, houseVar);
  const storeys = Math.max(1, storeysOverride ?? base.storeys);
  if (bi === featureBuildingIndex) {
    const damage = Math.min(base.damage, houseVar.roofHoleDamageThreshold * 0.6);
    return { ...base, storeys, wallColor: base.wallColorClean, damage, ivy: 0, collapsed: false };
  }
  return { ...base, storeys };
}

/** Options for `windowPlacements` — the world-config stride + boarded fraction + resolved house variation. */
export interface WindowPlacementOptions {
  readonly houseVar: HouseVariationParams;
  /** Place a window on every Nth eligible facade cell (world.houseWindowStride). */
  readonly stride: number;
  /** Fraction of damaged windows boarded vs smashed-open (world.houseWindowBoardedFraction). */
  readonly boardedFraction: number;
}

/**
 * The authored window cells of a scene + their seed-derived decay state (T70/T87). This is the SINGLE source
 * of truth the sim (WindowSystem seed) and the renderer (mesh build) both consume — both must derive the
 * identical placements, so a window that reads boarded/smashed renders that way AND simulates that way (V26).
 *
 * A window goes on every `stride`-th ELIGIBLE facade cell of each building: an on-perimeter, nav-blocked
 * cell that is neither a corner nor adjacent to a door opening (matching blockScene's loop exactly).
 */
export function windowPlacements(scene: WindowScene, opts: WindowPlacementOptions): WindowPlacement[] {
  // P0: a templated scene authored its windows from the floor-plan templates (placeHouse) — that set IS the
  // single source of truth, so the sim seed and the renderer mesh build read EXACTLY the same windows (V26).
  // The legacy facade-stride placement below remains for the GATE-0 / M1 blocks, which have no templates.
  if (scene.windowSeeds) return [...scene.windowSeeds];
  const grid = scene.navGrid;
  const cs = grid.settings.navCellSize;
  const featureIdx = featureBuildingIndexOf(scene);
  const doorAdjacent = (cx: number, cy: number): boolean =>
    scene.exitCells.some((e) => Math.abs(e.cx - cx) + Math.abs(e.cy - cy) <= 1);

  const out: WindowPlacement[] = [];
  buildingsOf(scene).forEach((bld, bi) => {
    const b = bld.bounds;
    const style = houseStyleForBuilding(b, bld.storeys, bi, opts.houseVar, featureIdx);
    let wi = 0;
    for (let cy = b.minCy; cy <= b.maxCy; cy++) {
      for (let cx = b.minCx; cx <= b.maxCx; cx++) {
        const onEdge = cx === b.minCx || cx === b.maxCx || cy === b.minCy || cy === b.maxCy;
        if (!onEdge || !grid.isBlocked(grid.index(cx, cy))) continue;
        const corner = (cx === b.minCx || cx === b.maxCx) && (cy === b.minCy || cy === b.maxCy);
        if (corner || doorAdjacent(cx, cy)) continue; // not a window slot — don't count it toward the stride
        const place = wi % opts.stride === 0;
        const slot = wi;
        wi += 1;
        if (!place) continue;
        const ns = cy === b.minCy || cy === b.maxCy;
        out.push({
          cx,
          cy,
          ns,
          slot,
          state: windowState(style, slot, opts.boardedFraction),
          storeys: style.storeys,
          x: (cx + 0.5) * cs,
          z: (cy + 0.5) * cs,
        });
      }
    }
  });
  return out;
}

/** Map an authored decay state to the live sim state. A `boarded` window is an opening covered by the full
 *  board count (tearing the boards off reveals the hole); a `broken` window is glassless from the start. */
function initialStateOf(state: WindowState, maxBoards: number): { glass: WindowGlass; boards: number } {
  switch (state) {
    case 'intact':
      return { glass: 'intact', boards: 0 };
    case 'broken':
      return { glass: 'open', boards: 0 };
    case 'boarded':
      return { glass: 'open', boards: maxBoards };
  }
}

interface WindowRecord {
  readonly cx: number;
  readonly cy: number;
  glass: WindowGlass;
  boards: number;
  /** Shot hits absorbed by the pane (smashes at `glassShotsToSmash`). */
  glassHits: number;
  /** Accumulated zombie attack ticks toward the next board-tear / pane-smash. */
  attackTicks: number;
}

/** The board count at which a window reads as CLOSED — the SECOND board (V82). A window boards UP TO TWICE,
 *  two DISTINCT stages: ONE board still leaves a shoot/see-through gap (it only blocks bodily ENTRY + adds
 *  attrition resistance), the SECOND board seals it into a solid wall-equivalent (no sight/projectile through).
 *  This is a fixed game rule (two boarding stages), not a tunable — `maxBoardsPerWindow` caps how many boards a
 *  window can hold (default 2), this names which board CLOSES it. */
export const BOARDS_TO_CLOSE = 2;

/** A SIGHT/PROJECTILE opening — a round / sight line passes through it: glass is gone AND it carries FEWER than
 *  `BOARDS_TO_CLOSE` boards (0 or 1). A second board CLOSES it (occludes like a wall — V82). PROJECTILE/LOS
 *  occlusion predicate ONLY — it does NOT make the cell nav-walkable (§G room-seal stays intact). */
function sightOpening(r: WindowRecord): boolean {
  return r.glass !== 'intact' && r.boards < BOARDS_TO_CLOSE;
}

/** FULLY open — glass gone AND ZERO boards: nothing left to attrite, and the only state the player can vault
 *  THROUGH (a single board blocks bodily entry, V70). Distinct from `sightOpening`, which a 1-board window
 *  passes for sight/projectiles but NOT for a body. */
function fullyOpen(r: WindowRecord): boolean {
  return r.glass !== 'intact' && r.boards === 0;
}

/** SEE-THROUGH (V84) — what LIGHT + VISION pass through, which is LOOSER than `sightOpening`: GLASS IS
 *  TRANSPARENT, so an INTACT pane lets sight + light through just like an open/smashed hole does. Only the
 *  SECOND board (`BOARDS_TO_CLOSE`) seals it visually. So a window is see-through iff it carries fewer than
 *  two boards, REGARDLESS of glass state. This is distinct from `sightOpening` (which additionally requires the
 *  glass be GONE) because a PROJECTILE must shatter the pane first while a SIGHT LINE / a LIGHT BEAM does not.
 *  (A curtain would also block this, but curtains are not modelled yet.) */
function seeThrough(r: WindowRecord): boolean {
  return r.boards < BOARDS_TO_CLOSE;
}

/**
 * The authoritative set of windows for a scene. Seeded from `windowPlacements` so the initial state matches
 * the render. Reads the nav grid for cell indexing only — it never mutates passability (§G — windows are
 * projectile/visual openings, not walk-through holes, so room A stays sealed until the wall is breached).
 */
export class WindowSystem {
  private readonly grid: NavGrid;
  private readonly navCellSize: number;
  private readonly cfg: WindowSystemConfig;
  private readonly byCell = new Map<number, WindowRecord>();

  constructor(grid: NavGrid, placements: readonly WindowPlacement[], cfg: WindowSystemConfig) {
    this.grid = grid;
    this.navCellSize = grid.settings.navCellSize;
    this.cfg = cfg;
    for (const p of placements) {
      const key = grid.index(p.cx, p.cy);
      if (this.byCell.has(key)) continue; // dedupe (a cell carries one window even across sills)
      const init = initialStateOf(p.state, cfg.maxBoards);
      this.byCell.set(key, { cx: p.cx, cy: p.cy, glass: init.glass, boards: init.boards, glassHits: 0, attackTicks: 0 });
    }
  }

  /** True iff the window at `navCell` is a SIGHT/PROJECTILE opening — a round / sight line passes through it
   *  (glass gone AND fewer than `BOARDS_TO_CLOSE` boards, i.e. 0 or 1). A 2-board window is CLOSED (occludes
   *  like a wall, V82). Used by the combat occlusion query + the interaction LOS gate; it never implies the
   *  cell is nav-walkable (§G). */
  isOpening(navCell: number): boolean {
    const w = this.byCell.get(navCell);
    return w ? sightOpening(w) : false;
  }

  /** True iff the window at `navCell` is FULLY open — glass gone AND ZERO boards. The ONLY state the player can
   *  climb THROUGH (a single board blocks bodily entry, V70); also the attrition-complete state (V82). */
  isFullyOpen(navCell: number): boolean {
    const w = this.byCell.get(navCell);
    return w ? fullyOpen(w) : false;
  }

  /** True iff SIGHT + LIGHT pass through the window at `navCell` (V84) — fewer than `BOARDS_TO_CLOSE` boards,
   *  REGARDLESS of glass (an intact pane is transparent). LOOSER than `isOpening`: a projectile needs the glass
   *  gone, a sight line / light beam does not. Used by player vision (cone + fog), zombie sight, and the
   *  flashlight clamp — never implies the cell is nav-walkable (§G). */
  isSeeThrough(navCell: number): boolean {
    const w = this.byCell.get(navCell);
    return w ? seeThrough(w) : false;
  }

  /** Nav-cell key for a window at (cx,cy), or -1 if no window lives there (incl. out-of-bounds coords —
   *  a shot ray can march past the grid edge, where there is definitionally no window). */
  cellOf(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.grid.width || cy >= this.grid.height) return -1;
    const key = this.grid.index(cx, cy);
    return this.byCell.has(key) ? key : -1;
  }

  has(navCell: number): boolean {
    return this.byCell.has(navCell);
  }

  glassOf(navCell: number): WindowGlass | undefined {
    return this.byCell.get(navCell)?.glass;
  }

  boardsOf(navCell: number): number | undefined {
    return this.byCell.get(navCell)?.boards;
  }

  /** Smash an intact pane outright (glass → smashed). No-op if it is already gone. Returns true on a change. */
  smashGlass(navCell: number): boolean {
    const w = this.byCell.get(navCell);
    if (!w || w.glass !== 'intact') return false;
    w.glass = 'smashed';
    w.glassHits = this.cfg.glassShotsToSmash;
    return true;
  }

  /**
   * Register a single projectile hit on a pane. The pane smashes once it has absorbed `glassShotsToSmash`
   * hits (default 1 — one bullet). Returns true the moment it smashes (the shot then passes through). A hit
   * on an already-open/smashed or boarded window is ignored (the pane is either gone or shielded).
   */
  applyGlassHit(navCell: number): boolean {
    const w = this.byCell.get(navCell);
    if (!w || w.glass !== 'intact' || w.boards > 0) return false;
    w.glassHits += 1;
    if (w.glassHits >= this.cfg.glassShotsToSmash) {
      w.glass = 'smashed';
      return true;
    }
    return false;
  }

  /** Add one board (defensive board-up). No-op at max. Returns true on a change. */
  addBoard(navCell: number): boolean {
    const w = this.byCell.get(navCell);
    if (!w || w.boards >= this.cfg.maxBoards) return false;
    w.boards += 1;
    return true;
  }

  /** Remove one board (pry it off). No-op at zero. Returns true on a change. */
  removeBoard(navCell: number): boolean {
    const w = this.byCell.get(navCell);
    if (!w || w.boards <= 0) return false;
    w.boards -= 1;
    return true;
  }

  /**
   * Advance zombie attrition for the windows currently under attack (a zombie within reach). Each cell
   * accumulates `ticks` of progress; crossing the per-stage threshold tears one board off (boards remain),
   * else smashes an intact pane — opening a shoot/see-through gap. Deterministic (driven by the under-attack
   * set). A window that is already FULLY open (glassless + unboarded) has nothing left to attrite — note a
   * 1-board glassless window is still attrited here (its last board is torn), even though it is a `sightOpening`
   * (V82): `fullyOpen` — NOT `sightOpening` — gates "nothing left to do". Returns the changed cells.
   */
  tick(underAttack: Iterable<number>, ticks: number): number[] {
    if (ticks <= 0) return [];
    const changed: number[] = [];
    for (const navCell of underAttack) {
      const w = this.byCell.get(navCell);
      if (!w || fullyOpen(w)) continue;
      w.attackTicks += ticks;
      if (w.boards > 0) {
        if (w.attackTicks >= this.cfg.ticksToBreakBoard) {
          w.attackTicks = 0;
          this.removeBoard(navCell);
          changed.push(navCell);
        }
      } else if (w.glass === 'intact') {
        if (w.attackTicks >= this.cfg.ticksToSmashGlass) {
          w.attackTicks = 0;
          this.smashGlass(navCell);
          changed.push(navCell);
        }
      }
    }
    return changed;
  }

  /** Live window views for the renderer (mesh swap) + interaction resolution. */
  list(): WindowView[] {
    const out: WindowView[] = [];
    for (const w of this.byCell.values()) {
      out.push({ cx: w.cx, cy: w.cy, x: (w.cx + 0.5) * this.navCellSize, z: (w.cy + 0.5) * this.navCellSize, glass: w.glass, boards: w.boards });
    }
    return out;
  }

  /** The nearest window to (x,z) within `rangeMeters` (planar), or null. Ties broken by lower nav cell. */
  nearest(x: number, z: number, rangeMeters: number): { window: WindowView; navCell: number; distanceMeters: number } | null {
    let best: { window: WindowView; navCell: number; distanceMeters: number } | null = null;
    for (const w of this.byCell.values()) {
      const wx = (w.cx + 0.5) * this.navCellSize;
      const wz = (w.cy + 0.5) * this.navCellSize;
      const dist = Math.hypot(wx - x, wz - z);
      if (dist > rangeMeters) continue;
      if (!best || dist < best.distanceMeters) {
        best = {
          window: { cx: w.cx, cy: w.cy, x: wx, z: wz, glass: w.glass, boards: w.boards },
          navCell: this.grid.index(w.cx, w.cy),
          distanceMeters: dist,
        };
      }
    }
    return best;
  }
}
