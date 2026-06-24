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
  /** Draw each zombie's sight perception radius (V14 sightRange). */
  readonly showSightRadius: boolean;
  /** Draw each zombie's attack-range radius (perception attackRangeMeters). */
  readonly showAttackRadius: boolean;
  /** Tint each zombie by its FSM state (idle/wander/pursue/attack/stagger/down). */
  readonly showZombieState: boolean;
  /** Visualize the shared stimulus/sound field (heard-event sources + intensity falloff). */
  readonly showSoundField: boolean;
  /** Draw the player's forward vision cone (Project-Zomboid-style awareness wedge). */
  readonly showPlayerVision: boolean;
  /**
   * Vision-cone fog-of-war: only draw crowd members inside the player's forward vision cone + range +
   * line-of-sight (Project-Zomboid-style look-around). Default ON; turn OFF to render the whole horde.
   */
  readonly cullToVisionCone: boolean;
  /** Player flashlight SpotLight on/off (toggled with F). Default ON — the main light source at night. */
  readonly flashlight: boolean;
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
  showSightRadius: false,
  showAttackRadius: false,
  showZombieState: false,
  showSoundField: false,
  showPlayerVision: false,
  // Gameplay render features (not overlays) — these default ON; dev can toggle them off for debugging.
  cullToVisionCone: true,
  flashlight: true,
  forceLodLevel: null,
};
// Frozen: this is a SHARED const default — never alias it into mutable state. A consumer that mutated the
// object returned by get() (which used to be this very const) corrupted the defaults for every later instance
// (an order-dependent test failure). DebugFlagState now COPIES it on init/reset; freezing makes any stray
// in-place write throw at the culprit instead of silently rotting the default.
Object.freeze(DEFAULT_DEBUG_FLAGS);

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
  'showSightRadius',
  'showAttackRadius',
  'showZombieState',
  'showSoundField',
  'showPlayerVision',
  'cullToVisionCone',
  'flashlight',
];

/** Mutable typed holder for the debug control flags. Node-testable; no DOM/3D dependency. */
export class DebugFlagState {
  private flags: DebugFlags = { ...DEFAULT_DEBUG_FLAGS };

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
    this.flags = { ...DEFAULT_DEBUG_FLAGS };
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
