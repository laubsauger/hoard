// T108 window system: reflects the authoritative window state onto the rendered meshes (the render only READS
// sim state, V12). An INTACT pane shows the glass; an OPEN/SMASHED window shows the dark void (a real
// see-through hole matching the cleared nav cell); a BOARDED window shows the void plus `boards` crossing
// planks. Keyed by nav cell so each window unit (and both sills of a two-storey cell) tracks the same live
// state. Extracted from BlockScene (docs/REFACTOR-godfiles.md).

import type { GameRuntime } from '../../../game/runtime';
import type { WindowGlass } from '../../../game/scene';
import type { WindowMesh } from '../builders/handles';

export class WindowSystem {
  constructor(private readonly windows: WindowMesh[]) {}

  sync(runtime: GameRuntime): void {
    if (this.windows.length === 0) return;
    const glassBy = new Map<number, { glass: WindowGlass; boards: number }>();
    for (const w of runtime.windowViews()) {
      glassBy.set(runtime.scene.navGrid.index(w.cx, w.cy), { glass: w.glass, boards: w.boards });
    }
    for (const u of this.windows) {
      const state = glassBy.get(u.navCell);
      if (!state) continue; // a window with no sim record keeps its built (primed) visibility
      const intact = state.glass === 'intact';
      u.pane.visible = intact;
      u.voidMesh.visible = !intact; // the opening reads as a dark void once the glass is gone
      for (let i = 0; i < u.boards.length; i++) u.boards[i]!.visible = i < state.boards;
    }
  }
}
