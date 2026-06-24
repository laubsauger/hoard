// T46 door system: eases each rendered door leaf toward the authoritative open/closed target (the render only
// REFLECTS sim state, V12). A CLOSED door's leaf lies in the wall plane (rotation 0); an OPEN one is swung
// ~90° about its hinge pivot at a configured angular speed (snaps at dt<=0, e.g. the construction-time prime,
// so a door that starts open renders open immediately). Keyed by nav cell. Extracted from BlockScene.

import type { GameRuntime } from '../../../game/runtime';
import { approach } from '../../lighting/lighting';
import type { DoorLeaf } from '../builders/handles';

export interface DoorSystemConfig {
  /** Angular ease speed (radians/second) the leaf rotates toward its open/closed target. */
  readonly swingSpeedRadiansPerSecond: number;
}

export class DoorSystem {
  constructor(
    private readonly leaves: DoorLeaf[],
    private readonly cfg: DoorSystemConfig,
  ) {}

  sync(runtime: GameRuntime, dtSeconds: number): void {
    if (this.leaves.length === 0) return;
    const access = new Map<number, string>();
    const grid = runtime.scene.navGrid;
    const cs = grid.settings.navCellSize;
    // Key by the floored door CENTRE (the edge midpoint for an edge-door, the cell centre for a legacy cell-door)
    // — the SAME index openingsBuilder tags each leaf with, so the leaf finds its authoritative open/closed state.
    for (const d of runtime.doorViews()) access.set(grid.index(Math.floor(d.x / cs), Math.floor(d.z / cs)), d.access);
    const speed = this.cfg.swingSpeedRadiansPerSecond;
    for (const leaf of this.leaves) {
      const target = access.get(leaf.navCell) === 'open' ? leaf.openTarget : 0;
      leaf.current = dtSeconds > 0 ? approach(leaf.current, target, speed, dtSeconds) : target;
      leaf.pivot.rotation.y = leaf.current;
    }
  }
}
