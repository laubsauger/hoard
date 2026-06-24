// T109 / V73 — FOG OF WAR (render-side perception VIEW, no sim/nav mutation). A coarse per-cell grid tracking
// three states across the world, exactly like a classic top-down fog of war:
//
//   • UNEXPLORED — never seen. Hidden under the darkest overlay.
//   • EXPLORED   — seen before but not visible right now. Dimmed/desaturated "memory" (you remember the layout).
//   • VISIBLE    — currently revealed this frame (inside the flashlight/vision cone OR the passive awareness
//                  radius, BOTH structurally line-of-sight gated). The overlay clears here.
//
// The grid is a PURE VIEW: it is fed each frame by the render layer (which decides VISIBLE per cell by reusing
// the SAME `instantaneousReveal` cone+near+LOS the crowd reveal uses — no second wall representation) and never
// flows back into the deterministic sim (V2/V26). Allocated once to the world cell count — `beginFrame` clears
// only the per-frame VISIBLE flags (the VISITED memory persists), so there is no per-frame allocation (V24).
// No three/GPU here — the texture/overlay mesh lives in the FogOfWarSystem; this is the testable model.

/** The three fog states a world cell can be in. */
export type FogState = 'unexplored' | 'explored' | 'visible';

/** Resolved overlay opacities per fog state (subset of the rendering config domain). 0 = fully clear. */
export interface FogDimConfig {
  /** Overlay opacity for an EXPLORED-but-not-visible cell (the dim "memory" layer). */
  readonly exploredDim: number;
  /** Overlay opacity for an UNEXPLORED cell (the darkest "never seen" layer). */
  readonly unexploredDim: number;
}

/** Classify a cell from its persistent VISITED flag + this-frame VISIBLE flag. Pure. */
export function fogCellState(visited: boolean, visible: boolean): FogState {
  if (visible) return 'visible';
  if (visited) return 'explored';
  return 'unexplored';
}

/** Target overlay opacity (0..1) for a fog state. VISIBLE is always fully clear (0). Pure. */
export function fogDim(state: FogState, cfg: FogDimConfig): number {
  switch (state) {
    case 'visible':
      return 0;
    case 'explored':
      return cfg.exploredDim;
    case 'unexplored':
      return cfg.unexploredDim;
  }
}

/**
 * Allocation-free coarse fog-of-war grid. `visited` is the persistent explored-memory (set once a cell is ever
 * seen, never cleared); `visible` is the per-frame currently-revealed set (cleared by `beginFrame`). Both are
 * row-major `cols × rows`. Bounds-checked accessors throw — an out-of-range cell is a mapping bug, not something
 * to silently clamp. Deterministic + pure view; nothing here touches the sim/nav.
 */
export class FogOfWarGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly visited: Uint8Array;
  private readonly visible: Uint8Array;

  constructor(cols: number, rows: number) {
    if (!Number.isInteger(cols) || cols <= 0) throw new Error(`cols must be a positive integer, got ${cols}`);
    if (!Number.isInteger(rows) || rows <= 0) throw new Error(`rows must be a positive integer, got ${rows}`);
    this.cols = cols;
    this.rows = rows;
    this.visited = new Uint8Array(cols * rows);
    this.visible = new Uint8Array(cols * rows);
  }

  private index(col: number, row: number): number {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) {
      throw new Error(`fog cell (${col},${row}) out of bounds ${this.cols}x${this.rows}`);
    }
    return row * this.cols + col;
  }

  /** Clear the per-frame VISIBLE set (the persistent VISITED memory is untouched). Call once per frame. */
  beginFrame(): void {
    this.visible.fill(0);
  }

  /** Mark a cell currently visible this frame — also records it as forever-VISITED (explored memory). */
  markVisible(col: number, row: number): void {
    const i = this.index(col, row);
    this.visible[i] = 1;
    this.visited[i] = 1;
  }

  isVisited(col: number, row: number): boolean {
    return this.visited[this.index(col, row)] === 1;
  }

  isVisible(col: number, row: number): boolean {
    return this.visible[this.index(col, row)] === 1;
  }

  /** The fog state of a cell this frame. */
  state(col: number, row: number): FogState {
    const i = this.index(col, row);
    return fogCellState(this.visited[i] === 1, this.visible[i] === 1);
  }

  /** Target overlay opacity (0..1) of a cell this frame, given the resolved dim levels. */
  dimAt(col: number, row: number, cfg: FogDimConfig): number {
    return fogDim(this.state(col, row), cfg);
  }
}
