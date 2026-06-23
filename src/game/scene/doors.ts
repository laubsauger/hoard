// T46 — authoritative DOOR state system (additive; sits on top of the nav grid, never rebuilds it).
//
// Doors are the building's front-door OPENINGS (the scene's `exitCells`). Unlike the destructible wall
// section (a StructuralModule), a door is a plain nav-grid cell that toggles passability: CLOSED blocks the
// cell (no nav, no line-of-sight, no sound through it — LOS/sound both consult `isWalkableWorld`, which reads
// the nav grid); OPEN clears it. State changes are driven by commands resolved on ticks (V12) — the renderer
// only REFLECTS the state (leaf rotation), it never mutates it. A LOCAL nav edit only (clear/block marks one
// tile dirty + bumps navRevision, V5) — never a region rebuild.

import type { NavGrid } from '@/game/navigation';
import type { CellXY } from './testBlock';

/** A door's passability state. Mirrors the interaction lane's AccessState without coupling to it. */
export type DoorAccess = 'open' | 'closed' | 'locked';

/** A live door: its nav cell, its world-plane centre, and its current access state. */
export interface DoorView {
  readonly cx: number;
  readonly cy: number;
  /** World-plane centre of the door cell (y = floor). */
  readonly x: number;
  readonly z: number;
  readonly access: DoorAccess;
  /** The grid axis the leaf spans: 'x' = the wall runs along X (leaf faces ±Z); 'z' = wall along Z. */
  readonly axis: 'x' | 'z';
}

interface DoorRecord {
  readonly cx: number;
  readonly cy: number;
  access: DoorAccess;
  readonly axis: 'x' | 'z';
}

/**
 * Decide the axis a door leaf spans from its perimeter neighbours: a door whose left/right (±X) neighbours
 * are blocked sits in an X-running wall (leaf spans X, faces ±Z); otherwise it sits in a Z-running wall.
 * Pure — used by both the sim (door view) and the renderer (leaf orientation) so they never disagree.
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

  constructor(grid: NavGrid, doors: readonly CellXY[]) {
    this.grid = grid;
    this.navCellSize = grid.settings.navCellSize;
    for (const d of doors) {
      const key = grid.index(d.cx, d.cy);
      if (this.byCell.has(key)) continue; // dedupe authored doors
      const access: DoorAccess = grid.isBlocked(key) ? 'closed' : 'open';
      this.byCell.set(key, { cx: d.cx, cy: d.cy, access, axis: doorAxis(grid, d.cx, d.cy) });
    }
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

  /** Open a door: clear its nav cell so nav + sight + sound pass through it (V5 local edit). No-op if locked. */
  open(navCell: number): boolean {
    const d = this.byCell.get(navCell);
    if (!d || d.access === 'locked') return false;
    if (d.access === 'open') return true;
    d.access = 'open';
    this.grid.clear(d.cx, d.cy);
    return true;
  }

  /** Close a door: block its nav cell so it stops nav + sight + sound (V5 local edit). No-op if locked. */
  close(navCell: number): boolean {
    const d = this.byCell.get(navCell);
    if (!d || d.access === 'locked') return false;
    if (d.access === 'closed') return true;
    d.access = 'closed';
    this.grid.block(d.cx, d.cy);
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

  /** Live door views for the renderer (leaf orientation + rotation) and interaction resolution. */
  list(): DoorView[] {
    const out: DoorView[] = [];
    for (const d of this.byCell.values()) {
      out.push({
        cx: d.cx,
        cy: d.cy,
        x: (d.cx + 0.5) * this.navCellSize,
        z: (d.cy + 0.5) * this.navCellSize,
        access: d.access,
        axis: d.axis,
      });
    }
    return out;
  }

  /** The nearest door to (x,z) within `rangeMeters` (planar), or null. Ties broken by lower nav cell. */
  nearest(x: number, z: number, rangeMeters: number): { door: DoorView; navCell: number; distanceMeters: number } | null {
    let best: { door: DoorView; navCell: number; distanceMeters: number } | null = null;
    for (const d of this.byCell.values()) {
      const wx = (d.cx + 0.5) * this.navCellSize;
      const wz = (d.cy + 0.5) * this.navCellSize;
      const dist = Math.hypot(wx - x, wz - z);
      if (dist > rangeMeters) continue;
      if (!best || dist < best.distanceMeters) {
        best = {
          door: { cx: d.cx, cy: d.cy, x: wx, z: wz, access: d.access, axis: d.axis },
          navCell: this.grid.index(d.cx, d.cy),
          distanceMeters: dist,
        };
      }
    }
    return best;
  }
}
