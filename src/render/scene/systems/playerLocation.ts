// Pure player-location queries shared by the per-frame systems (cutaway, lighting, contact-AO): which building
// footprint the player currently occupies, and whether they are indoors at all. Reads the authoritative town
// scene's building bounds (V26) — never world mesh state. Extracted from BlockScene (docs/REFACTOR-godfiles.md).

import { buildingsOf, type TestBlock } from '../../../game/scene';

/** Index of the building whose footprint contains world-XZ (x,z), or -1 if the player is out on the street/yard. */
export function buildingIndexAt(town: TestBlock, navCellSize: number, x: number, z: number): number {
  const cx = Math.floor(x / navCellSize);
  const cy = Math.floor(z / navCellSize);
  const buildings = buildingsOf(town);
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i]!.bounds;
    if (cx >= b.minCx && cx <= b.maxCx && cy >= b.minCy && cy <= b.maxCy) return i;
  }
  return -1;
}

/** Whether world-XZ (x,z) lies inside any building footprint. */
export function isInside(town: TestBlock, navCellSize: number, x: number, z: number): boolean {
  return buildingIndexAt(town, navCellSize, x, z) >= 0;
}
