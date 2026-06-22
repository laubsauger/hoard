// T35 / §I debug controls — typed toggle state for debug controls.
// This lane OWNS the flag state + its reporting. The actual 3D gizmo rendering of these flags
// (grid meshes, flow-field arrows, dirty-tile highlights, forced-LOD swaps, tier freeze) is a later
// RENDER-LANE integration: render reads this state through a narrow getter and draws accordingly.
// See DEFERRED note at bottom.

/** Boolean debug controls (§I: freeze tiers / show spatial grids / visualize flow fields / inspect dirty nav tiles). */
export interface DebugFlags {
  /** Freeze tier promotion/demotion so a scene can be inspected at a fixed tier assignment. */
  readonly freezeTiers: boolean;
  /** Show spatial-hash + chunk/sector/district/nav-tile boundary grids. */
  readonly showSpatialGrids: boolean;
  /** Visualize flow-field vectors + path corridors + portals + blocked links. */
  readonly visualizeFlowFields: boolean;
  /** Highlight dirty navigation tiles awaiting rebuild. */
  readonly inspectDirtyNavTiles: boolean;
  /** Show structural occupancy cells + support links + dirty regions. */
  readonly showStructuralCells: boolean;
  /**
   * Force every renderable crowd member to a fixed LOD level for fidelity inspection.
   * null = automatic LOD selection (no override). A non-negative integer pins that LOD.
   */
  readonly forceLodLevel: number | null;
}

export const DEFAULT_DEBUG_FLAGS: DebugFlags = {
  freezeTiers: false,
  showSpatialGrids: false,
  visualizeFlowFields: false,
  inspectDirtyNavTiles: false,
  showStructuralCells: false,
  forceLodLevel: null,
};

/** Keys of the boolean (toggleable) flags only. forceLodLevel is set, not toggled. */
export type BooleanDebugFlag = {
  [K in keyof DebugFlags]: DebugFlags[K] extends boolean ? K : never;
}[keyof DebugFlags];

const BOOLEAN_FLAG_KEYS: readonly BooleanDebugFlag[] = [
  'freezeTiers',
  'showSpatialGrids',
  'visualizeFlowFields',
  'inspectDirtyNavTiles',
  'showStructuralCells',
];

/** Mutable typed holder for the debug control flags. Node-testable; no DOM/3D dependency. */
export class DebugFlagState {
  private flags: DebugFlags = DEFAULT_DEBUG_FLAGS;

  get(): DebugFlags {
    return this.flags;
  }

  /** Flip a single boolean control. Returns the new flag set. */
  toggle(key: BooleanDebugFlag): DebugFlags {
    this.flags = { ...this.flags, [key]: !this.flags[key] };
    return this.flags;
  }

  /** Explicitly set a single boolean control. */
  set(key: BooleanDebugFlag, value: boolean): DebugFlags {
    this.flags = { ...this.flags, [key]: value };
    return this.flags;
  }

  /**
   * Pin a forced LOD level, or pass null to return to automatic selection.
   * Rejects negatives / non-integers (no silent coercion).
   */
  setForceLod(level: number | null): DebugFlags {
    if (level !== null && (!Number.isInteger(level) || level < 0)) {
      throw new Error(`forceLodLevel must be null or a non-negative integer, got ${level}`);
    }
    this.flags = { ...this.flags, forceLodLevel: level };
    return this.flags;
  }

  reset(): DebugFlags {
    this.flags = DEFAULT_DEBUG_FLAGS;
    return this.flags;
  }

  /** Names of the boolean controls — used by the overlay to render toggle rows. */
  static booleanKeys(): readonly BooleanDebugFlag[] {
    return BOOLEAN_FLAG_KEYS;
  }
}

// ----------------------------------------------------------------------------------------------
// DEFERRED to render-lane integration (T28/T30/T32 follow-ups):
//   - 3D rendering of spatial grids / boundary lines (showSpatialGrids).
//   - Flow-field vector arrows + corridor/portal/blocked-link gizmos (visualizeFlowFields).
//   - Dirty-nav-tile highlight overlay (inspectDirtyNavTiles).
//   - Structural occupancy/support-link gizmos (showStructuralCells).
//   - Applying forceLodLevel / freezeTiers in the crowd render + tier scheduler.
// Lane X owns ONLY the flag state above + its HTML reporting in the overlay; render reads this state.
// ----------------------------------------------------------------------------------------------
