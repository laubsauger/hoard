// T11 / V15 — shared flow field over the cost grid.
// V15: large groups do NOT each run A*. One flow field is computed toward a target cell (Dijkstra
// over the cost grid) and SHARED by every agent heading to that target. Each cell stores a direction
// vector pointing down the cost gradient — follow it and you converge on the target.
// Cached by (targetCell, movementProfile, navRevision) so a stale field is dropped after a nav edit.

import type { NavGrid } from './navGrid';

const UNREACHABLE = Number.POSITIVE_INFINITY;

/** 8-neighbour offsets (cardinal + diagonal). Diagonals cost √2× the entered cell. */
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

/** Binary min-heap over (key=distance, val=cell) on parallel arrays — the Dijkstra frontier. Replaces the
 *  old O(N²) linear-scan + `includes` frontier that froze the frame when a flow field recomputed (e.g. a
 *  gunshot retargeting the horde lure). Lazy deletion: stale entries are skipped on pop. O(N log N). */
export class MinHeap {
  private readonly keys: number[] = [];
  private readonly vals: number[] = [];
  get size(): number {
    return this.vals.length;
  }
  push(key: number, val: number): void {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.vals.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= this.keys[i]!) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): { key: number; val: number } {
    const key = this.keys[0]!;
    const val = this.vals[0]!;
    const lastK = this.keys.pop()!;
    const lastV = this.vals.pop()!;
    const n = this.vals.length;
    if (n > 0) {
      this.keys[0] = lastK;
      this.vals[0] = lastV;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = i * 2 + 2;
        let m = i;
        if (l < n && this.keys[l]! < this.keys[m]!) m = l;
        if (r < n && this.keys[r]! < this.keys[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return { key, val };
  }
  private swap(a: number, b: number): void {
    const k = this.keys[a]!;
    this.keys[a] = this.keys[b]!;
    this.keys[b] = k;
    const v = this.vals[a]!;
    this.vals[a] = this.vals[b]!;
    this.vals[b] = v;
  }
}

export class FlowField {
  /** Accumulated cost-to-target per cell (Infinity = unreachable). */
  readonly distance: Float64Array;
  /** Per-cell flow direction (unit-ish), dirX/dirZ interleaved. Zero at target + unreachable cells. */
  readonly dir: Float32Array;

  constructor(
    readonly grid: NavGrid,
    readonly targetCell: number,
    readonly movementProfile: string,
    readonly navRevision: number,
  ) {
    const n = grid.cellCount;
    this.distance = new Float64Array(n).fill(UNREACHABLE);
    this.dir = new Float32Array(n * 2);
    this.compute();
  }

  /** Direction vector at a cell as [dirX, dirZ] in world axes. */
  directionAt(cell: number): [number, number] {
    return [this.dir[cell * 2]!, this.dir[cell * 2 + 1]!];
  }

  isReachable(cell: number): boolean {
    return Number.isFinite(this.distance[cell]!);
  }

  private compute(): void {
    const grid = this.grid;
    if (grid.isBlocked(this.targetCell)) {
      throw new Error(`flow-field target cell ${this.targetCell} is blocked`);
    }
    // Dijkstra from the target outward, binary-heap frontier (O(N log N)). Lazy deletion: a cell may be
    // pushed multiple times; the stale pops (key > recorded distance) are skipped.
    this.distance[this.targetCell] = 0;
    const heap = new MinHeap();
    heap.push(0, this.targetCell);
    while (heap.size > 0) {
      const { key, val: cell } = heap.pop();
      if (key > this.distance[cell]!) continue; // stale entry
      const { cx, cy } = grid.coordOf(cell);
      for (const nb of NEIGHBORS) {
        const nx = cx + nb.dx;
        const ny = cy + nb.dy;
        if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
        const ncell = ny * grid.width + nx;
        if (grid.isBlocked(ncell)) continue;
        // Interior partition (edge-wall): the field does NOT flow across a walled edge, so paths route
        // through DOORWAYS. A diagonal is blocked if either perpendicular edge is walled (no corner-cut).
        if (!grid.canStep(cx, cy, nb.dx, nb.dy)) continue;
        const step = grid.getCost(ncell) * (nb.diag ? SQRT2 : 1);
        const nd = key + step;
        if (nd < this.distance[ncell]!) {
          this.distance[ncell] = nd;
          heap.push(nd, ncell);
        }
      }
    }
    this.buildDirections();
  }

  /** For each reachable cell, point toward the neighbour with the lowest cost-to-target. */
  private buildDirections(): void {
    const grid = this.grid;
    for (let cell = 0; cell < grid.cellCount; cell++) {
      if (!Number.isFinite(this.distance[cell]!) || cell === this.targetCell) continue;
      const { cx, cy } = grid.coordOf(cell);
      let bestCell = -1;
      let bestDist = this.distance[cell]!;
      for (const nb of NEIGHBORS) {
        const nx = cx + nb.dx;
        const ny = cy + nb.dy;
        if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
        // Don't point the flow vector across an interior wall — the gradient must follow a crossable edge.
        if (!grid.canStep(cx, cy, nb.dx, nb.dy)) continue;
        const ncell = ny * grid.width + nx;
        const d = this.distance[ncell]!;
        if (d < bestDist) {
          bestDist = d;
          bestCell = ncell;
        }
      }
      if (bestCell >= 0) {
        const bc = grid.coordOf(bestCell);
        let dx = bc.cx - cx;
        let dz = bc.cy - cy;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
        this.dir[cell * 2] = dx;
        this.dir[cell * 2 + 1] = dz;
      }
    }
  }
}

/** LRU cache of flow fields keyed by (targetCell, movementProfile, navRevision). */
export class FlowFieldCache {
  private readonly map = new Map<string, FlowField>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`FlowFieldCache capacity must be a positive integer, got ${capacity}`);
    }
  }

  get size(): number {
    return this.map.size;
  }

  private static key(targetCell: number, profile: string, navRevision: number): string {
    return `${targetCell}|${profile}|${navRevision}`;
  }

  /** Get an existing field or compute + cache one. A bumped navRevision yields a distinct key. */
  get(grid: NavGrid, targetCell: number, movementProfile: string): FlowField {
    const key = FlowFieldCache.key(targetCell, movementProfile, grid.navRevision);
    const existing = this.map.get(key);
    if (existing) {
      // refresh LRU recency
      this.map.delete(key);
      this.map.set(key, existing);
      return existing;
    }
    const field = new FlowField(grid, targetCell, movementProfile, grid.navRevision);
    this.map.set(key, field);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return field;
  }

  has(targetCell: number, movementProfile: string, navRevision: number): boolean {
    return this.map.has(FlowFieldCache.key(targetCell, movementProfile, navRevision));
  }

  clear(): void {
    this.map.clear();
  }
}
