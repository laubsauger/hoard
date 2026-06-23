// The shared inputs every scene builder needs: the Three root to add meshes to, the tracked-resource factory,
// the authoritative town scene (nav grid + building footprints + ground paint), and the nav cell size. Each
// builder additionally takes its own resolved typed config (V4). Part of the blockScene decomposition
// (docs/REFACTOR-godfiles.md). Builders read the scene through this narrow handle — never the GameRuntime.

import type { Scene } from 'three';
import type { TestBlock } from '../../../game/scene';
import type { SceneResources } from './sceneResources';

export interface BuildContext {
  /** Three scene root — builders add their groups/meshes here. */
  readonly root: Scene;
  /** Tracked material/geometry factory (disposal + diagnostics, V24). */
  readonly res: SceneResources;
  /** The authoritative town scene: nav grid, building footprints, ground paint, props (read-only). */
  readonly town: TestBlock;
  /** World metres per nav cell. */
  readonly navCellSize: number;
}

/** District extent in world metres (nav grid size × cell size). */
export function worldExtent(town: TestBlock, navCellSize: number): { width: number; depth: number } {
  return { width: town.navGrid.width * navCellSize, depth: town.navGrid.height * navCellSize };
}
