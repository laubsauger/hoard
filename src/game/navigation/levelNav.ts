// P3a — per-level navigation + STAIR LINKS (multi-floor sim core, docs/PROCEDURAL-HOUSES.md "P3 multi-floor
// model"). The scene carries a stack of nav LEVELS: level 0 = the whole district (today), level 1 = SPARSE
// upstairs cells under 2-storey houses, etc. A STAIR LINK is a vertical PORTAL EDGE in the nav graph: it
// connects a cell on one level to a cell on another level (same world XZ) and is traversable by pathfinding/
// flow, DISTINCT from the 4-neighbour `canStep` edges (which never cross levels).
//
// BACKWARD-COMPAT IS THE GREEN-KEEPER. A `LevelNav` with a single level and ZERO stair links is byte-identical
// to a bare `NavGrid` flow field: the global cell space collapses to level 0's local indices (offset 0), the
// neighbour expansion order + costs match `FlowField` exactly, and `stairLinksFrom` returns empty. So a
// 1-storey / all-outdoors world routes EXACTLY as today; every existing test stays green. Only when level-1
// cells + stair links are present does the field expand across floors.

import { resolveDomain } from '@/config/registry';
import { navigationConfig } from '@/config/domains/navigation';
import type { QualityTier } from '@/config/types';
import { NavGrid } from './navGrid';
import { MinHeap } from './flowField';

const UNREACHABLE = Number.POSITIVE_INFINITY;
const REFERENCE_TIER: QualityTier = 'desktop-high';

/** 8-neighbour offsets (cardinal + diagonal) — mirrors FlowField so a single-level field matches it byte-for-byte. */
const NEIGHBORS: readonly { dx: number; dy: number; diag: boolean }[] = [
  { dx: 1, dy: 0, diag: false },
  { dx: -1, dy: 0, diag: false },
  { dx: 0, dy: 1, diag: false },
  { dx: 0, dy: -1, diag: false },
  { dx: 1, dy: 1, diag: true },
  { dx: 1, dy: -1, diag: true },
  { dx: -1, dy: 1, diag: true },
  { dx: -1, dy: -1, diag: true },
];
const SQRT2 = Math.SQRT2;

/**
 * A directed stair-link portal edge: traverse from `(fromLevel, fromCell)` to `(toLevel, toCell)`. Stored as a
 * DIRECTED edge; `addStairLink` records BOTH directions so a stair can be climbed up AND descended. The cells
 * sit at the SAME world XZ on adjacent levels (the renderer stacks level-1 geometry +storeyHeight Y).
 */
export interface StairLink {
  readonly fromLevel: number;
  readonly fromCell: number;
  readonly toLevel: number;
  readonly toCell: number;
}

/**
 * A stack of nav levels + the stair-link portal graph between them. `levels[0]` is the ground/district grid
 * (required); higher levels are sparse upper floors. Stair links are vertical portal edges the flow field /
 * pathfinding traverse. Deterministic + allocation-light: links live in insertion-ordered arrays so traversal
 * order is replay-stable (V26).
 */
export class LevelNav {
  readonly levels: readonly NavGrid[];
  /** Global cell offset for each level (sum of lower levels' cellCount). levelOffsets[0] === 0. */
  private readonly levelOffsets: readonly number[];
  /** Per-(level,cell) outgoing stair links, keyed `${level}:${cell}`. */
  private readonly linksByCell = new Map<string, StairLink[]>();
  /** Every link in insertion order (deterministic traversal). */
  private readonly allLinks: StairLink[] = [];
  /** Bumped on every stair-link edit so a cached field keyed off `navRevision` is dropped after a topology change. */
  private _stairRevision = 0;

  constructor(levels: readonly NavGrid[]) {
    if (levels.length === 0) throw new Error('LevelNav requires at least the ground level (levels[0])');
    this.levels = levels;
    const offsets: number[] = [];
    let acc = 0;
    for (const g of levels) {
      offsets.push(acc);
      acc += g.cellCount;
    }
    this.levelOffsets = offsets;
  }

  /** Build a single-level nav (level 0 only) around an existing grid — the backward-compat wrapper. */
  static single(grid: NavGrid): LevelNav {
    return new LevelNav([grid]);
  }

  get levelCount(): number {
    return this.levels.length;
  }

  /** The nav grid for a level (throws on an out-of-range level — surfaced, not silently clamped). */
  grid(level: number): NavGrid {
    const g = this.levels[level];
    if (!g) throw new Error(`LevelNav has no level ${level} (levelCount ${this.levels.length})`);
    return g;
  }

  /** Total cells across every level (the global cell-space size). */
  get totalCells(): number {
    return this.levelOffsets[this.levels.length - 1]! + this.levels[this.levels.length - 1]!.cellCount;
  }

  /** Global cell index for a (level, localCell) pair. */
  globalCell(level: number, cell: number): number {
    return this.levelOffsets[level]! + cell;
  }

  /** Decode a global cell index back to (level, localCell). */
  decode(globalCell: number): { level: number; cell: number } {
    // small level counts → linear scan is cheaper than a binary search and stays allocation-free.
    for (let l = this.levels.length - 1; l >= 0; l--) {
      const off = this.levelOffsets[l]!;
      if (globalCell >= off) return { level: l, cell: globalCell - off };
    }
    return { level: 0, cell: globalCell };
  }

  /**
   * Add a stair link between `(fromLevel, fromCell)` and `(toLevel, toCell)`. Records BOTH directions (climb up
   * + descend) so the portal is bidirectional. Bumps the stair revision so stale cached fields are dropped.
   * Validates the cells are in range on their levels (surfaced, not silently dropped — a bad link is a content bug).
   */
  addStairLink(fromLevel: number, fromCell: number, toLevel: number, toCell: number): void {
    const a = this.grid(fromLevel);
    const b = this.grid(toLevel);
    if (fromCell < 0 || fromCell >= a.cellCount) throw new Error(`stair link fromCell ${fromCell} out of range on level ${fromLevel}`);
    if (toCell < 0 || toCell >= b.cellCount) throw new Error(`stair link toCell ${toCell} out of range on level ${toLevel}`);
    this.pushLink({ fromLevel, fromCell, toLevel, toCell });
    this.pushLink({ fromLevel: toLevel, fromCell: toCell, toLevel: fromLevel, toCell: fromCell });
    this._stairRevision += 1;
  }

  private pushLink(link: StairLink): void {
    const key = `${link.fromLevel}:${link.fromCell}`;
    const list = this.linksByCell.get(key);
    if (list) list.push(link);
    else this.linksByCell.set(key, [link]);
    this.allLinks.push(link);
  }

  /** The outgoing stair links from a cell (each names its destination level + cell). Empty when none. */
  stairLinksFrom(level: number, cell: number): readonly StairLink[] {
    return this.linksByCell.get(`${level}:${cell}`) ?? [];
  }

  /** Every stair link (both directions), in insertion order. */
  get stairLinks(): readonly StairLink[] {
    return this.allLinks;
  }

  /**
   * Combined revision across every level grid + the stair topology — the cache key that drops a stale field
   * after ANY level's nav edit or a stair-link change. Level 0's `navRevision` dominates the common case.
   */
  get navRevision(): number {
    let r = this._stairRevision;
    for (const g of this.levels) r = r * 0x9e3779b1 + g.navRevision;
    return r >>> 0;
  }
}

/**
 * A flow field over a `LevelNav`: Dijkstra from a target `(level, cell)` outward across every level, expanding
 * 4/8-neighbour edges WITHIN a level (gated by `canStep` + cell-blocking, exactly like `FlowField`) and STAIR
 * LINKS across levels. Each reachable cell gets a cost-to-target + a per-level flow vector; a cell whose
 * cheapest next step is a stair (the linked cell is closer than any in-level neighbour) is flagged so a
 * climbing agent knows to take the portal instead of steering in-plane.
 *
 * For a single-level nav with no stair links this reproduces `FlowField` (same neighbour order + costs), so it
 * is a drop-in for the multi-floor case without disturbing the level-0 hot path.
 */
export class LevelFlowField {
  /** Cost-to-target per GLOBAL cell (Infinity = unreachable). */
  readonly distance: Float64Array;
  /** Per-global-cell in-level flow direction (dirX/dirZ interleaved). Zero at the target, unreachable, and
   *  cells whose next move is a stair climb. */
  readonly dir: Float32Array;
  /** Per-global-cell index into the nav's stair-link list for the climb to take here, or -1 (no climb). */
  private readonly stairIdx: Int32Array;
  private readonly stairTraversalCost: number;

  constructor(
    readonly nav: LevelNav,
    readonly targetLevel: number,
    readonly targetCell: number,
    readonly movementProfile: string,
    readonly navRevision: number,
    tier: QualityTier = REFERENCE_TIER,
  ) {
    const n = nav.totalCells;
    this.distance = new Float64Array(n).fill(UNREACHABLE);
    this.dir = new Float32Array(n * 2);
    this.stairIdx = new Int32Array(n).fill(-1);
    this.stairTraversalCost = resolveDomain(navigationConfig, tier).stairTraversalCost;
    this.compute();
  }

  /** Direction vector at a (level, cell) as [dirX, dirZ] in world axes. */
  directionAt(level: number, cell: number): [number, number] {
    const g = this.nav.globalCell(level, cell);
    return [this.dir[g * 2]!, this.dir[g * 2 + 1]!];
  }

  isReachable(level: number, cell: number): boolean {
    return Number.isFinite(this.distance[this.nav.globalCell(level, cell)]!);
  }

  distanceAt(level: number, cell: number): number {
    return this.distance[this.nav.globalCell(level, cell)]!;
  }

  /**
   * The stair link an agent at `(level, cell)` should take to progress toward the target (its cheapest next
   * step is the climb), or null when it should steer in-plane. This is how a pursuer on the wrong floor knows
   * to climb the stairs at the stair cell.
   */
  stairFrom(level: number, cell: number): StairLink | null {
    const idx = this.stairIdx[this.nav.globalCell(level, cell)]!;
    return idx < 0 ? null : (this.nav.stairLinks[idx] ?? null);
  }

  private compute(): void {
    const nav = this.nav;
    const targetGrid = nav.grid(this.targetLevel);
    const targetGlobal = nav.globalCell(this.targetLevel, this.targetCell);
    if (targetGrid.isBlocked(this.targetCell)) {
      throw new Error(`level-flow-field target (level ${this.targetLevel}, cell ${this.targetCell}) is blocked`);
    }
    this.distance[targetGlobal] = 0;
    const heap = new MinHeap();
    heap.push(0, targetGlobal);
    while (heap.size > 0) {
      const { key, val: gcell } = heap.pop();
      if (key > this.distance[gcell]!) continue; // stale entry
      const { level, cell } = nav.decode(gcell);
      const grid = nav.grid(level);
      const w = grid.width;
      const cx = cell % w;
      const cy = (cell - cx) / w;
      // in-level 4/8-neighbour expansion — identical to FlowField (canStep gates partitions + corner-cuts).
      for (const nb of NEIGHBORS) {
        const nx = cx + nb.dx;
        const ny = cy + nb.dy;
        if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
        const nlocal = ny * grid.width + nx;
        if (grid.isBlocked(nlocal)) continue;
        if (!grid.canStep(cx, cy, nb.dx, nb.dy)) continue;
        const step = grid.getCost(nlocal) * (nb.diag ? SQRT2 : 1);
        const nd = key + step;
        const nglobal = nav.globalCell(level, nlocal);
        if (nd < this.distance[nglobal]!) {
          this.distance[nglobal] = nd;
          heap.push(nd, nglobal);
        }
      }
      // stair-link expansion across levels (the portal edges). Costs a flat stair-traversal cost (V4).
      for (const link of nav.stairLinksFrom(level, cell)) {
        const toGrid = nav.grid(link.toLevel);
        if (toGrid.isBlocked(link.toCell)) continue;
        const nd = key + this.stairTraversalCost;
        const nglobal = nav.globalCell(link.toLevel, link.toCell);
        if (nd < this.distance[nglobal]!) {
          this.distance[nglobal] = nd;
          heap.push(nd, nglobal);
        }
      }
    }
    this.buildDirections();
  }

  /**
   * For each reachable cell, decide its cheapest next step: the lowest-distance crossable in-level neighbour OR
   * a stair link. If a stair is at least as good as the best neighbour the cell is flagged for a climb (dir
   * stays zero — the agent takes the portal); otherwise the cell points along the in-level cost gradient.
   */
  private buildDirections(): void {
    const nav = this.nav;
    for (let l = 0; l < nav.levelCount; l++) {
      const grid = nav.grid(l);
      const w = grid.width;
      const base = nav.globalCell(l, 0);
      for (let cell = 0; cell < grid.cellCount; cell++) {
        const gcell = base + cell;
        const own = this.distance[gcell]!;
        if (!Number.isFinite(own) || gcell === nav.globalCell(this.targetLevel, this.targetCell)) continue;
        const cx = cell % w;
        const cy = (cell - cx) / w;
        // best in-level neighbour
        let bestCell = -1;
        let bestDist = own;
        for (const nb of NEIGHBORS) {
          const nx = cx + nb.dx;
          const ny = cy + nb.dy;
          if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
          if (!grid.canStep(cx, cy, nb.dx, nb.dy)) continue;
          const d = this.distance[base + ny * grid.width + nx]!;
          if (d < bestDist) {
            bestDist = d;
            bestCell = ny * grid.width + nx;
          }
        }
        // best stair link
        let bestStairIdx = -1;
        let bestStairDist = own;
        const links = nav.stairLinksFrom(l, cell);
        for (const link of links) {
          const d = this.distance[nav.globalCell(link.toLevel, link.toCell)]!;
          if (d < bestStairDist) {
            bestStairDist = d;
            bestStairIdx = nav.stairLinks.indexOf(link);
          }
        }
        if (bestStairIdx >= 0 && bestStairDist <= bestDist) {
          this.stairIdx[gcell] = bestStairIdx; // climb here; dir stays zero
          continue;
        }
        if (bestCell >= 0) {
          const bcx = bestCell % w;
          const bcy = (bestCell - bcx) / w;
          let dx = bcx - cx;
          let dz = bcy - cy;
          const len = Math.hypot(dx, dz) || 1;
          dx /= len;
          dz /= len;
          this.dir[gcell * 2] = dx;
          this.dir[gcell * 2 + 1] = dz;
        }
      }
    }
  }
}

/** LRU cache of level flow fields keyed by (targetLevel, targetCell, profile, navRevision). */
export class LevelFlowFieldCache {
  private readonly map = new Map<string, LevelFlowField>();

  constructor(
    private readonly capacity: number,
    private readonly tier: QualityTier = REFERENCE_TIER,
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`LevelFlowFieldCache capacity must be a positive integer, got ${capacity}`);
    }
  }

  get size(): number {
    return this.map.size;
  }

  private static key(level: number, cell: number, profile: string, navRevision: number): string {
    return `${level}|${cell}|${profile}|${navRevision}`;
  }

  /** Get an existing field or compute + cache one. A bumped navRevision (any level / stair edit) yields a new key. */
  get(nav: LevelNav, targetLevel: number, targetCell: number, profile: string): LevelFlowField {
    const rev = nav.navRevision;
    const key = LevelFlowFieldCache.key(targetLevel, targetCell, profile, rev);
    const existing = this.map.get(key);
    if (existing) {
      this.map.delete(key);
      this.map.set(key, existing);
      return existing;
    }
    const field = new LevelFlowField(nav, targetLevel, targetCell, profile, rev, this.tier);
    this.map.set(key, field);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return field;
  }

  clear(): void {
    this.map.clear();
  }
}
