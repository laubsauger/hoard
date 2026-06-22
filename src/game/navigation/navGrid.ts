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
