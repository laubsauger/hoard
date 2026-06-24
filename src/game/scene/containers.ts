// T85/B-cupboard — FIXED placement of lootable world containers (the kitchen cupboard). Pure + runtime-
// independent (headless-testable): given the authored scene, pick a STABLE interior cell for each lootable
// container — NOT the live/spawn player cell (which made the cupboard "follow" the player and read as the
// nearest interactable house-wide). The cupboard sits in a corner of the player's room so it is only
// interactable when the player walks up to THAT spot (range-gated by the interaction reach).
//
// The runtime anchors the container's ContainerRef + interactable here, and the renderer draws a cabinet
// mesh at the same cell — both consume this single source of truth, so the visible box and the interactable
// hotspot always coincide.

import { buildingsOf, type CellRect, type CellXY, type TestBlock } from './testBlock';
import type { NavGrid } from '@/game/navigation';

/** A placed lootable container: the nav cell it occupies + its display label (the inventory container key). */
export interface ContainerPlacement {
  readonly cell: CellXY;
  readonly label: string;
}

/** The scene fields container placement needs — a narrow slice so this stays unit-testable without a runtime.
 *  `exitCells` + `windowSeeds` let the cabinet AVOID a cell that already carries a door/window opening (so the
 *  cabinet never sits on — and its glow never merges with — a window/door, V79). */
type ContainerScene = Pick<TestBlock, 'playerCell' | 'buildings' | 'buildingBounds' | 'navGrid' | 'exitCells' | 'windowSeeds' | 'roomAt'>;

const CONTAINER_DIR_DELTA: Record<'n' | 's' | 'e' | 'w', { dx: number; dy: number }> = {
  n: { dx: 0, dy: -1 },
  s: { dx: 0, dy: 1 },
  e: { dx: 1, dy: 0 },
  w: { dx: -1, dy: 0 },
};

/** Nav cells already occupied by a door/window OPENING — the floored world centre of each (the edge midpoint for
 *  a thin-wall edge-door/window, the cell itself for a legacy cell-opening). The cabinet skips these so it never
 *  lands on a window/door (which would also merge the active-interactable glow of the two). */
function openingCells(scene: ContainerScene): Set<number> {
  const grid = scene.navGrid;
  const cs = grid.settings.navCellSize;
  const out = new Set<number>();
  const floorCell = (x: number, z: number): number => grid.index(Math.floor(x / cs), Math.floor(z / cs));
  for (const e of scene.exitCells) {
    if (e.edgeDir) {
      const { dx, dy } = CONTAINER_DIR_DELTA[e.edgeDir];
      out.add(floorCell((e.cx + 0.5 + dx * 0.5) * cs, (e.cy + 0.5 + dy * 0.5) * cs));
    } else {
      out.add(grid.index(e.cx, e.cy));
    }
  }
  for (const w of scene.windowSeeds ?? []) out.add(floorCell(w.x, w.z));
  return out;
}

/** The building (shell footprint) the player starts in, or the union bounds if none contains the start cell. */
function playerBuildingBounds(scene: ContainerScene): CellRect {
  const { cx, cy } = scene.playerCell;
  for (const b of buildingsOf(scene)) {
    const r = b.bounds;
    if (cx >= r.minCx && cx <= r.maxCx && cy >= r.minCy && cy <= r.maxCy) return r;
  }
  return scene.buildingBounds;
}

/** The CORNER of `b` FARTHEST from `cell` (the sheltered spawn) — the room corner across the room, so the cabinet
 *  lands OUT of immediate reach of the spawn (interaction-range gated). For a thin-wall house the building bounds
 *  ARE the walkable room cells, so the corner is the bounds corner itself; for a legacy cell-walled block the
 *  bounds corner is a wall cell and `nearestWalkableInterior` slides off it to the first room cell. Deterministic:
 *  ties break toward the lower (cx,cy). */
function farthestInteriorCorner(b: CellRect, cell: CellXY): CellXY {
  const corners: CellXY[] = [
    { cx: b.minCx, cy: b.minCy },
    { cx: b.maxCx, cy: b.minCy },
    { cx: b.minCx, cy: b.maxCy },
    { cx: b.maxCx, cy: b.maxCy },
  ];
  let best = corners[0]!;
  let bestD = -1;
  for (const c of corners) {
    const d = (c.cx - cell.cx) ** 2 + (c.cy - cell.cy) ** 2;
    if (d > bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** The WALKABLE cell of `b` nearest `corner` (so the cabinet sits on floor, clear of walls/partitions). Scans
 *  the FULL bounds — a legacy block's perimeter wall ring is `isBlocked` so it is skipped (the cabinet lands on
 *  the first interior room cell), while a thin-wall house's perimeter cells are walkable so the cabinet can sit
 *  at the true room corner. Deterministic scan (cy then cx) with a strict `<` so the first cell wins on a tie.
 *  Throws if a building has no walkable cell (a content error — V4, no silent miss). */
function nearestWalkableInterior(grid: NavGrid, b: CellRect, corner: CellXY, avoid: Set<number>): CellXY {
  let best: CellXY | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (let cy = b.minCy; cy <= b.maxCy; cy++) {
    for (let cx = b.minCx; cx <= b.maxCx; cx++) {
      const idx = grid.index(cx, cy);
      if (grid.isBlocked(idx)) continue;
      if (avoid.has(idx)) continue; // a window/door already lives here — keep the cabinet off it
      const d = (cx - corner.cx) ** 2 + (cy - corner.cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { cx, cy };
      }
    }
  }
  if (!best) throw new Error(`building (${b.minCx},${b.minCy})-(${b.maxCx},${b.maxCy}) has no walkable interior cell for a container`);
  return best;
}

/** The WALKABLE cell of the player's OWN room FARTHEST from the player — so the kitchen cupboard sits across the
 *  player's open-plan room (out of immediate reach, range-gated) yet stays IN that room: reachable without
 *  crossing a wall/closed door, and never sealed in a back bedroom (T135 — the captive room). Null if the scene
 *  has no room map or the room yields no free cell (caller falls back to the whole-building corner). */
function farthestWalkableInPlayerRoom(scene: ContainerScene, b: CellRect, avoid: Set<number>): CellXY | null {
  if (!scene.roomAt) return null;
  const pr = scene.roomAt(scene.playerCell.cx, scene.playerCell.cy);
  if (!pr) return null;
  const grid = scene.navGrid;
  let best: CellXY | null = null;
  let bestD = -1;
  for (let cy = b.minCy; cy <= b.maxCy; cy++) {
    for (let cx = b.minCx; cx <= b.maxCx; cx++) {
      const idx = grid.index(cx, cy);
      if (grid.isBlocked(idx) || avoid.has(idx)) continue;
      const r = scene.roomAt(cx, cy);
      if (!r || r.houseIndex !== pr.houseIndex || r.roomId !== pr.roomId) continue; // stay inside the player's room
      const d = (cx - scene.playerCell.cx) ** 2 + (cy - scene.playerCell.cy) ** 2;
      if (d > bestD) {
        bestD = d;
        best = { cx, cy };
      }
    }
  }
  return best;
}

/**
 * The FIXED cells of the scene's lootable world containers (T85). For the slice this is ONE kitchen cupboard
 * anchored across the player's OWN room (the open-plan kitchen/living) — a stable spot, never the live player
 * cell. T135: room-constrained so the "Kitchen Cupboard" lands in the kitchen (reachable, range-gated), not in
 * a sealed back bedroom (the captive room) the farthest house corner would pick. Falls back to the whole-building
 * farthest corner for scenes with no room map (the bare GATE-0 / M1 blocks).
 */
export function lootableContainerCells(scene: ContainerScene): ContainerPlacement[] {
  const bounds = playerBuildingBounds(scene);
  const avoid = openingCells(scene);
  const inRoom = farthestWalkableInPlayerRoom(scene, bounds, avoid);
  const cell = inRoom ?? nearestWalkableInterior(scene.navGrid, bounds, farthestInteriorCorner(bounds, scene.playerCell), avoid);
  return [{ cell, label: 'Kitchen Cupboard' }];
}
