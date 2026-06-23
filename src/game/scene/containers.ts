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

/** The scene fields container placement needs — a narrow slice so this stays unit-testable without a runtime. */
type ContainerScene = Pick<TestBlock, 'playerCell' | 'buildings' | 'buildingBounds' | 'navGrid'>;

/** The building (shell footprint) the player starts in, or the union bounds if none contains the start cell. */
function playerBuildingBounds(scene: ContainerScene): CellRect {
  const { cx, cy } = scene.playerCell;
  for (const b of buildingsOf(scene)) {
    const r = b.bounds;
    if (cx >= r.minCx && cx <= r.maxCx && cy >= r.minCy && cy <= r.maxCy) return r;
  }
  return scene.buildingBounds;
}

/** The INTERIOR corner (inset one cell off the perimeter walls) of `b` nearest to `cell` — the player's room
 *  corner. Deterministic: ties break toward the lower (cx,cy). */
function nearestInteriorCorner(b: CellRect, cell: CellXY): CellXY {
  const corners: CellXY[] = [
    { cx: b.minCx + 1, cy: b.minCy + 1 },
    { cx: b.maxCx - 1, cy: b.minCy + 1 },
    { cx: b.minCx + 1, cy: b.maxCy - 1 },
    { cx: b.maxCx - 1, cy: b.maxCy - 1 },
  ];
  let best = corners[0]!;
  let bestD = Number.POSITIVE_INFINITY;
  for (const c of corners) {
    const d = (c.cx - cell.cx) ** 2 + (c.cy - cell.cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** The WALKABLE interior cell of `b` nearest `corner` (so the cabinet sits clear of walls + the partition).
 *  Deterministic scan (cy then cx) with a strict `<` so the first cell wins on a tie. Throws if a building
 *  has no walkable interior cell (a content error — V4, no silent miss). */
function nearestWalkableInterior(grid: NavGrid, b: CellRect, corner: CellXY): CellXY {
  let best: CellXY | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (let cy = b.minCy + 1; cy <= b.maxCy - 1; cy++) {
    for (let cx = b.minCx + 1; cx <= b.maxCx - 1; cx++) {
      if (grid.isBlocked(grid.index(cx, cy))) continue;
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

/**
 * The FIXED cells of the scene's lootable world containers (T85). For the slice this is ONE kitchen cupboard
 * anchored in a corner of the player's start room — a stable spot derived from the building bounds, never the
 * live player cell. Returned as a list so multiple authored containers slot in without touching the callers.
 */
export function lootableContainerCells(scene: ContainerScene): ContainerPlacement[] {
  const bounds = playerBuildingBounds(scene);
  const corner = nearestInteriorCorner(bounds, scene.playerCell);
  const cell = nearestWalkableInterior(scene.navGrid, bounds, corner);
  return [{ cell, label: 'Kitchen Cupboard' }];
}
