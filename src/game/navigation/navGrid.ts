// T11 / V5 — tiled uniform-grid navmesh + cost grid.
// A render chunk's walkable area is a uniform grid of cost cells. Cells are grouped into nav tiles
// (§I ~16 m). A local edit (a breach, a barricade) marks ONLY the tiles it touches dirty and bumps
// navRevision — it NEVER triggers a full-grid rebuild (V5). Flow fields key off navRevision so a
// stale field is never served after the cost grid changes.

import { resolveDomain } from '@/config/registry';
import { navigationConfig } from '@/config/domains/navigation';
import type { QualityTier, ResolvedDomain } from '@/config/types';

export type NavSettings = ResolvedDomain<typeof navigationConfig>;

const REFERENCE_TIER: QualityTier = 'desktop-high';

export interface NavGridOptions {
  /** Grid width in cells. */
  readonly width: number;
  /** Grid height in cells. */
  readonly height: number;
  readonly tier?: QualityTier;
}

export interface CellCoord {
  readonly cx: number;
  readonly cy: number;
}

/** A cell EDGE direction (the face shared with the neighbour one step that way). */
export type WallDir = 'n' | 's' | 'e' | 'w';

/** Per-cell wall bitfield slots (N/S/E/W). A bit set ⇒ that cell edge carries a wall. */
const WALL_N = 1;
const WALL_S = 2;
const WALL_E = 4;
const WALL_W = 8;

function wallBit(dir: WallDir): number {
  switch (dir) {
    case 'n':
      return WALL_N;
    case 's':
      return WALL_S;
    case 'e':
      return WALL_E;
    case 'w':
      return WALL_W;
  }
}

/** The opposite edge — the same wall seen from the neighbour cell (so the block is symmetric). */
function oppositeBit(dir: WallDir): number {
  switch (dir) {
    case 'n':
      return WALL_S;
    case 's':
      return WALL_N;
    case 'e':
      return WALL_W;
    case 'w':
      return WALL_E;
  }
}

function dirDelta(dir: WallDir): { dx: number; dy: number } {
  switch (dir) {
    case 'n':
      return { dx: 0, dy: -1 };
    case 's':
      return { dx: 0, dy: 1 };
    case 'e':
      return { dx: 1, dy: 0 };
    case 'w':
      return { dx: -1, dy: 0 };
  }
}

export class NavGrid {
  readonly width: number;
  readonly height: number;
  readonly settings: NavSettings;
  /** Cells per tile edge (tileSize / cellSize). */
  readonly tileCells: number;
  readonly tilesX: number;
  readonly tilesY: number;

  /** Per-cell traversal cost. blockedCost marks an impassable cell. */
  private readonly cost: Uint32Array;
  /**
   * Per-cell EDGE-wall bitfield (N/S/E/W). A wall on the edge between two cells sets the matching bit on
   * BOTH cells (the cell's dir + the neighbour's opposite dir), so crossing is blocked symmetrically while
   * BOTH cells stay walkable — the Project-Zomboid interior-partition model. Cell-blocking (`cost`) is the
   * sealed exterior shell; edge-walls are the interior partitions a 2 m cell grid can't otherwise express.
   */
  private readonly edges: Uint8Array;
  private _navRevision = 0;
  private readonly dirtyTiles = new Set<number>();

  constructor(opts: NavGridOptions) {
    if (!Number.isInteger(opts.width) || opts.width <= 0) throw new Error(`NavGrid width must be a positive integer, got ${opts.width}`);
    if (!Number.isInteger(opts.height) || opts.height <= 0) throw new Error(`NavGrid height must be a positive integer, got ${opts.height}`);
    this.settings = resolveDomain(navigationConfig, opts.tier ?? REFERENCE_TIER);
    const ratio = this.settings.navTileSize / this.settings.navCellSize;
    if (!Number.isInteger(ratio) || ratio <= 0) {
      throw new Error(`navTileSize/navCellSize must be a positive integer ratio, got ${ratio}`);
    }
    this.width = opts.width;
    this.height = opts.height;
    this.tileCells = ratio;
    this.tilesX = Math.ceil(opts.width / ratio);
    this.tilesY = Math.ceil(opts.height / ratio);
    this.cost = new Uint32Array(opts.width * opts.height).fill(this.settings.baseTraversalCost);
    this.edges = new Uint8Array(opts.width * opts.height);
  }

  get navRevision(): number {
    return this._navRevision;
  }

  get cellCount(): number {
    return this.width * this.height;
  }

  index(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) {
      throw new Error(`cell (${cx},${cy}) out of bounds ${this.width}x${this.height}`);
    }
    return cy * this.width + cx;
  }

  coordOf(cell: number): CellCoord {
    if (!Number.isInteger(cell) || cell < 0 || cell >= this.cellCount) {
      throw new Error(`cell index ${cell} out of bounds`);
    }
    return { cx: cell % this.width, cy: Math.floor(cell / this.width) };
  }

  /** World-meter (x,z) → cell coordinate (y is the up axis, ignored here). */
  worldToCell(x: number, z: number): CellCoord {
    const cx = Math.floor(x / this.settings.navCellSize);
    const cy = Math.floor(z / this.settings.navCellSize);
    return { cx, cy };
  }

  /** Tile index owning a cell coordinate. */
  tileOf(cx: number, cy: number): number {
    const tx = Math.floor(cx / this.tileCells);
    const ty = Math.floor(cy / this.tileCells);
    return ty * this.tilesX + tx;
  }

  getCost(cell: number): number {
    if (cell < 0 || cell >= this.cellCount) throw new Error(`cell ${cell} out of bounds`);
    return this.cost[cell]!;
  }

  isBlocked(cell: number): boolean {
    return this.getCost(cell) >= this.settings.blockedCost;
  }

  /**
   * Set a cell's cost (or block it). Marks ONLY the owning tile dirty and bumps navRevision (V5).
   * Returns the tile index that was marked dirty.
   */
  setCost(cx: number, cy: number, cost: number): number {
    const cell = this.index(cx, cy);
    if (cost < 0 || Number.isNaN(cost)) throw new Error(`cost must be non-negative, got ${cost}`);
    if (this.cost[cell] === cost) return this.tileOf(cx, cy); // no change, no dirtying
    this.cost[cell] = cost;
    const tile = this.tileOf(cx, cy);
    this.dirtyTiles.add(tile);
    this._navRevision += 1;
    return tile;
  }

  /** Block a cell (impassable). Local edit → local dirty (V5). */
  block(cx: number, cy: number): number {
    return this.setCost(cx, cy, this.settings.blockedCost);
  }

  /** Clear a cell back to base traversal cost. */
  clear(cx: number, cy: number): number {
    return this.setCost(cx, cy, this.settings.baseTraversalCost);
  }

  // ---- edge-walls (interior partitions; cells stay walkable) -----------------------------------------

  private inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.width && cy < this.height;
  }

  /**
   * Set (or clear) the wall on a cell's `dir` edge. Sets the matching bit on (cx,cy) AND the opposite bit on
   * the neighbour one step that way, so the block is symmetric and BOTH cells stay walkable. Marks the owning
   * tiles dirty + bumps navRevision so a stale flow field is never served after a partition is added (V5).
   * A no-op write (bit already in the requested state) neither dirties nor bumps. Deterministic, alloc-free.
   */
  setEdgeWall(cx: number, cy: number, dir: WallDir, on: boolean): void {
    const cell = this.index(cx, cy); // throws if (cx,cy) out of bounds
    const bit = wallBit(dir);
    const had = (this.edges[cell]! & bit) !== 0;
    if (had === on) return; // no change → no dirty, no bump
    if (on) this.edges[cell]! |= bit;
    else this.edges[cell]! &= ~bit;
    this.dirtyTiles.add(this.tileOf(cx, cy));
    const { dx, dy } = dirDelta(dir);
    const nx = cx + dx;
    const ny = cy + dy;
    if (this.inBounds(nx, ny)) {
      const ncell = ny * this.width + nx;
      const obit = oppositeBit(dir);
      if (on) this.edges[ncell]! |= obit;
      else this.edges[ncell]! &= ~obit;
      this.dirtyTiles.add(this.tileOf(nx, ny));
    }
    this._navRevision += 1;
  }

  /**
   * Put (or remove) a wall on the shared edge between two 4-neighbour cells. Convenience wrapper over
   * `setEdgeWall` — the placer feeds interior partition edges in here. Throws if the cells are not 4-neighbours.
   */
  setWallBetween(ax: number, ay: number, bx: number, by: number, on = true): void {
    const dir = this.dirBetween(ax, ay, bx, by);
    this.setEdgeWall(ax, ay, dir, on);
  }

  /** The edge direction from (ax,ay) toward its 4-neighbour (bx,by). Throws if they are not 4-neighbours. */
  private dirBetween(ax: number, ay: number, bx: number, by: number): WallDir {
    const dx = bx - ax;
    const dy = by - ay;
    if (Math.abs(dx) + Math.abs(dy) !== 1) {
      throw new Error(`cells (${ax},${ay})-(${bx},${by}) are not 4-neighbours`);
    }
    if (dx === 1) return 'e';
    if (dx === -1) return 'w';
    if (dy === 1) return 's';
    return 'n';
  }

  /** True when the cell's `dir` edge carries a wall. */
  wallOnEdge(cx: number, cy: number, dir: WallDir): boolean {
    const cell = this.index(cx, cy);
    return (this.edges[cell]! & wallBit(dir)) !== 0;
  }

  /**
   * Can a body cross from (ax,ay) to its 4-neighbour (bx,by)? False iff a wall sits on the shared edge. Cells
   * must be 4-neighbours (throws otherwise) and in bounds. O(1) bit test — safe in the flow-field/steering hot
   * loops. Cell-blocking is orthogonal: a blocked cell is still impassable regardless of edges (callers test
   * `isBlocked` themselves).
   */
  canCross(ax: number, ay: number, bx: number, by: number): boolean {
    const dir = this.dirBetween(ax, ay, bx, by);
    const cell = this.index(ax, ay); // throws if out of bounds
    this.index(bx, by); // bounds-check the neighbour too
    return (this.edges[cell]! & wallBit(dir)) === 0;
  }

  /**
   * Can a body step one cell from (cx,cy) by (dx,dy) (each in -1..1, not both 0) without crossing an edge-wall?
   * Cardinal: the single shared edge must be clear. Diagonal: NO corner-cut — every one of the four edges that
   * meet the corner the diagonal slips past must be clear (block if ANY is walled), so a diagonal can never
   * squeeze through a walled corner from either the origin OR the destination side. Reads the edge bitfield
   * directly (no validation throws) — assumes the destination is in bounds (callers gate bounds + cell-blocked
   * first). O(1), allocation-free — safe in the flow-field/steering/LOS hot loops.
   */
  canStep(cx: number, cy: number, dx: number, dy: number): boolean {
    const w = this.width;
    const e = this.edges;
    const cell = cy * w + cx;
    if (dx === 0) return (e[cell]! & (dy < 0 ? WALL_N : WALL_S)) === 0;
    if (dy === 0) return (e[cell]! & (dx < 0 ? WALL_W : WALL_E)) === 0;
    // diagonal: A=(cx,cy), B=(cx+dx,cy), C=(cx,cy+dy), D=(cx+dx,cy+dy). The four corner edges are A-B, A-C,
    // B-D, C-D — all must be open or the diagonal would clip a partition.
    const ex = dx < 0 ? WALL_W : WALL_E;
    const ey = dy < 0 ? WALL_N : WALL_S;
    if ((e[cell]! & ex) !== 0) return false; // A-B
    if ((e[cell]! & ey) !== 0) return false; // A-C
    if ((e[cy * w + (cx + dx)]! & ey) !== 0) return false; // B-D (B's edge toward D)
    if ((e[(cy + dy) * w + cx]! & ex) !== 0) return false; // C-D (C's edge toward D)
    return true;
  }

  /** Snapshot of currently-dirty tiles (the only tiles a rebuild must touch — V5). */
  dirtyTileList(): number[] {
    return [...this.dirtyTiles].sort((a, b) => a - b);
  }

  get dirtyTileCount(): number {
    return this.dirtyTiles.size;
  }

  /** Consume the dirty set — caller (or worker) rebuilds exactly these tiles, then they are clean. */
  consumeDirtyTiles(): number[] {
    const list = this.dirtyTileList();
    this.dirtyTiles.clear();
    return list;
  }
}
