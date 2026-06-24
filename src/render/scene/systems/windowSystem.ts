// T108 window system: reflects the authoritative window state onto the rendered meshes (the render only READS
// sim state, V12). The dark VOID box is NEVER shown — it read as a dark wall. A window is just GLASS (when
// intact) or a CLEAR see-through hole (glass gone), with BOARDS optionally laid OVER either one — so a boarded
// window stays see-through between the planks (boards-over-glass or boards-over-hole, both in their own
// see-through way). Keyed by nav cell so each window unit (+ both sills of a two-storey cell) tracks the same
// live state. Extracted from BlockScene (docs/REFACTOR-godfiles.md).

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
      u.pane.visible = state.glass === 'intact'; // glass when intact, else a clear hole
      u.voidMesh.visible = false; // NEVER a dark fill — boards (below) lay over the glass/hole, still see-through
      for (let i = 0; i < u.boards.length; i++) u.boards[i]!.visible = i < state.boards;
    }
  }
}
