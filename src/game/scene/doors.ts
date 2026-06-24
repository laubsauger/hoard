// T46 — authoritative DOOR state system (additive; sits on top of the nav grid, never rebuilds it).
//
// Doors are the building's front-door OPENINGS (the scene's `exitCells`). Unlike the destructible wall
// section (a StructuralModule), a door is a plain nav-grid cell that toggles passability: CLOSED blocks the
// cell (no nav, no line-of-sight, no sound through it — LOS/sound both consult `isWalkableWorld`, which reads
// the nav grid); OPEN clears it. State changes are driven by commands resolved on ticks (V12) — the renderer
// only REFLECTS the state (leaf rotation), it never mutates it. A LOCAL nav edit only (clear/block marks one
// tile dirty + bumps navRevision, V5) — never a region rebuild.

import type { NavGrid, WallDir } from '@/game/navigation';
import type { CellXY } from './testBlock';

/** A door's passability state. Mirrors the interaction lane's AccessState without coupling to it. */
export type DoorAccess = 'open' | 'closed' | 'locked';

/**
 * A door SPEC the system is built from. A plain `CellXY` (legacy §G/cityBlock) is a CELL-door: open/close
 * toggles the cell's passability. When `edgeDir` is present the door is an EDGE-door (the thin-wall house
 * model): `(cx,cy)` is the INNER room cell and the door is the EXTERIOR/INTERIOR cell EDGE on that side —
 * open/close toggles the EDGE-wall between the two cells (both stay walkable), never the cell. The two paths
 * coexist so the legacy cell-door scenes keep working while the templated houses author edge-doors.
 */
export interface DoorSpec {
  readonly cx: number;
  readonly cy: number;
  /** Edge-door: the OUTWARD edge direction (n/s/e/w). Absent ⇒ legacy cell-door. */
  readonly edgeDir?: WallDir;
}

/** A live door: its nav cell, its world-plane centre, and its current access state. */
export interface DoorView {
  readonly cx: number;
  readonly cy: number;
  /** World-plane centre of the door (the EDGE midpoint for an edge-door; the cell centre for a cell-door). */
  readonly x: number;
  readonly z: number;
  readonly access: DoorAccess;
  /** The grid axis the leaf spans: 'x' = the wall runs along X (leaf faces ±Z); 'z' = wall along Z. */
  readonly axis: 'x' | 'z';
  /** Edge-door outward direction (n/s/e/w), or undefined for a legacy cell-door. */
  readonly dir?: WallDir;
}

interface DoorRecord {
  readonly cx: number;
  readonly cy: number;
  access: DoorAccess;
  readonly axis: 'x' | 'z';
  /** Edge-door: the outward dir + the neighbour cell whose shared edge the door toggles; null = cell-door. */
  readonly edge: { readonly dir: WallDir; readonly nx: number; readonly ny: number } | null;
}

const DIR_DELTA: Record<WallDir, { dx: number; dy: number }> = {
  n: { dx: 0, dy: -1 },
  s: { dx: 0, dy: 1 },
  e: { dx: 1, dy: 0 },
  w: { dx: -1, dy: 0 },
};

/**
 * The axis a door leaf spans, derived from the door's OUTWARD edge direction: an n/s door sits in a wall that
 * runs along X (leaf spans X, faces ±Z) → 'x'; an e/w door sits in a Z-running wall → 'z'. The edge-door
 * counterpart of `doorAxis` — the renderer + sim derive leaf orientation from the door's `dir`, not from
 * blocked perimeter neighbour cells (which no longer exist around a thin-wall house). Pure.
 */
export function doorAxisForDir(dir: WallDir): 'x' | 'z' {
  return dir === 'n' || dir === 's' ? 'x' : 'z';
}

/**
 * Decide the axis a door leaf spans from its perimeter neighbours: a door whose left/right (±X) neighbours
 * are blocked sits in an X-running wall (leaf spans X, faces ±Z); otherwise it sits in a Z-running wall.
 * Pure — used by both the sim (door view) and the renderer (leaf orientation) so they never disagree.
 * (Legacy CELL-door path; edge-doors use `doorAxisForDir` since they have no blocked neighbour cells.)
 */
export function doorAxis(grid: NavGrid, cx: number, cy: number): 'x' | 'z' {
  const blocked = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return true; // out of bounds reads as wall
    return grid.isBlocked(grid.index(x, y));
  };
  const alongX = blocked(cx - 1, cy) && blocked(cx + 1, cy);
  return alongX ? 'x' : 'z';
}

/** Is (cx,cy) one of the scene's door openings? Pure predicate — the renderer omits the wall panel here so a
 *  real DOORWAY GAP exists (the leaf fills it when closed) rather than a leaf floating on a solid wall. */
export function isDoorCell(doors: readonly CellXY[], cx: number, cy: number): boolean {
  for (const d of doors) if (d.cx === cx && d.cy === cy) return true;
  return false;
}

/**
 * The authoritative set of doors for a scene. Built from the scene's door openings; each door's INITIAL
 * access is read from the live nav grid (a blocked door cell ⇒ closed/locked, an open gap ⇒ open) so the
 * sim state always matches the authored geometry.
 */
export class DoorSystem {
  private readonly grid: NavGrid;
  private readonly navCellSize: number;
  private readonly byCell = new Map<number, DoorRecord>();

  constructor(grid: NavGrid, doors: readonly DoorSpec[]) {
    this.grid = grid;
    this.navCellSize = grid.settings.navCellSize;
    for (const d of doors) {
      const key = grid.index(d.cx, d.cy);
      if (this.byCell.has(key)) continue; // dedupe authored doors
      if (d.edgeDir !== undefined) {
        // EDGE-door: state lives on the cell EDGE toward `edgeDir`. Initial access reads the live edge-wall
        // (a walled edge ⇒ closed, a clear edge ⇒ open) so the sim matches the authored geometry. The two
        // cells stay walkable — only the cross-edge toggles.
        const { dx, dy } = DIR_DELTA[d.edgeDir];
        const access: DoorAccess = grid.wallOnEdge(d.cx, d.cy, d.edgeDir) ? 'closed' : 'open';
        this.byCell.set(key, {
          cx: d.cx,
          cy: d.cy,
          access,
          axis: doorAxisForDir(d.edgeDir),
          edge: { dir: d.edgeDir, nx: d.cx + dx, ny: d.cy + dy },
        });
        continue;
      }
      const access: DoorAccess = grid.isBlocked(key) ? 'closed' : 'open';
      this.byCell.set(key, { cx: d.cx, cy: d.cy, access, axis: doorAxis(grid, d.cx, d.cy), edge: null });
    }
  }

  /** World-plane centre of a door record (the EDGE midpoint for an edge-door, else the cell centre). */
  private centreOf(d: DoorRecord): { x: number; z: number } {
    const cs = this.navCellSize;
    if (d.edge) {
      const { dx, dy } = DIR_DELTA[d.edge.dir];
      return { x: (d.cx + 0.5 + dx * 0.5) * cs, z: (d.cy + 0.5 + dy * 0.5) * cs };
    }
    return { x: (d.cx + 0.5) * cs, z: (d.cy + 0.5) * cs };
  }

  /** Nav-cell key for a door at (cx,cy), or -1 if no door lives there. */
  cellOf(cx: number, cy: number): number {
    const key = this.grid.index(cx, cy);
    return this.byCell.has(key) ? key : -1;
  }

  has(navCell: number): boolean {
    return this.byCell.has(navCell);
  }

  accessOf(navCell: number): DoorAccess | undefined {
    return this.byCell.get(navCell)?.access;
  }

  /** True when the door at navCell is an EDGE-door (thin-wall house): closing WALLS the cell edge but BOTH cells
   *  stay walkable — so closing can never trap a body in a solid cell, unlike a legacy cell-door. False for a
   *  cell-door or no door. The door-close trap-guard (V42) only needs to fire for cell-doors. */
  isEdgeDoor(navCell: number): boolean {
    return this.byCell.get(navCell)?.edge != null;
  }

  /** Open a door: an edge-door CLEARS its cell EDGE (both cells stay walkable); a cell-door CLEARS its cell —
   *  either way nav + sight + sound pass through it (V5 local edit). No-op if locked. */
  open(navCell: number): boolean {
    const d = this.byCell.get(navCell);
    if (!d || d.access === 'locked') return false;
    if (d.access === 'open') return true;
    d.access = 'open';
    if (d.edge) this.grid.setWallBetween(d.cx, d.cy, d.edge.nx, d.edge.ny, false);
    else this.grid.clear(d.cx, d.cy);
    return true;
  }

  /** Close a door: an edge-door WALLS its cell EDGE (both cells stay walkable); a cell-door BLOCKS its cell —
   *  either way it stops nav + sight + sound (V5 local edit). No-op if locked. */
  close(navCell: number): boolean {
    const d = this.byCell.get(navCell);
    if (!d || d.access === 'locked') return false;
    if (d.access === 'closed') return true;
    d.access = 'closed';
    if (d.edge) this.grid.setWallBetween(d.cx, d.cy, d.edge.nx, d.edge.ny, true);
    else this.grid.block(d.cx, d.cy);
    return true;
  }

  /** Toggle a door open↔closed. Returns the resulting access, or undefined if no door / locked. */
  toggle(navCell: number): DoorAccess | undefined {
    const d = this.byCell.get(navCell);
    if (!d || d.access === 'locked') return undefined;
    if (d.access === 'open') this.close(navCell);
    else this.open(navCell);
    return this.byCell.get(navCell)!.access;
  }

  /** Build the immutable view for a door record (edge midpoint + dir for an edge-door). */
  private viewOf(d: DoorRecord): DoorView {
    const { x, z } = this.centreOf(d);
    return d.edge
      ? { cx: d.cx, cy: d.cy, x, z, access: d.access, axis: d.axis, dir: d.edge.dir }
      : { cx: d.cx, cy: d.cy, x, z, access: d.access, axis: d.axis };
  }

  /** Live door views for the renderer (leaf orientation + rotation) and interaction resolution. */
  list(): DoorView[] {
    const out: DoorView[] = [];
    for (const d of this.byCell.values()) out.push(this.viewOf(d));
    return out;
  }

  /** The nearest door to (x,z) within `rangeMeters` (planar), or null. Ties broken by lower nav cell. */
  nearest(x: number, z: number, rangeMeters: number): { door: DoorView; navCell: number; distanceMeters: number } | null {
    let best: { door: DoorView; navCell: number; distanceMeters: number } | null = null;
    for (const d of this.byCell.values()) {
      const { x: wx, z: wz } = this.centreOf(d);
      const dist = Math.hypot(wx - x, wz - z);
      if (dist > rangeMeters) continue;
      if (!best || dist < best.distanceMeters) {
        best = { door: this.viewOf(d), navCell: this.grid.index(d.cx, d.cy), distanceMeters: dist };
      }
    }
    return best;
  }
}
