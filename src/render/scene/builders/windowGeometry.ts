// Shared window-opening geometry. The house wall PUNCH (houseBuilder) and the glass / void / frame FILL
// (openingsBuilder) both derive their opening from these helpers, so the hole cut through the wall and the
// pane that sits in it are guaranteed identical (V26 determinism) — no duplicated literals to drift apart.
// Render-only geometry (no sim/passability impact); the cells themselves come from windowPlacements().

/** Window opening height as a fraction of ONE storey's wall height (residential picture-window scale). */
const WINDOW_HEIGHT_FRACTION = 0.42;
/** Ground-floor sill height as a fraction of one storey's wall height. */
const WINDOW_SILL_FRACTION = 0.45;
/** Horizontal opening width as a fraction of the nav-cell run — leaves a small jamb reveal on each side. */
const WINDOW_SPAN_FRACTION = 0.85;

/** The wall shell thickness: the configured panel thickness, never wider than one nav cell (a thin shell). */
export function wallShellThicknessMeters(wallPanelThicknessMeters: number, navCellSize: number): number {
  return Math.min(wallPanelThicknessMeters, navCellSize);
}

/** Vertical extent of a window opening (sill→header). */
export function windowOpeningHeightMeters(storeyHeightMeters: number): number {
  return storeyHeightMeters * WINDOW_HEIGHT_FRACTION;
}

/** Horizontal extent of a window opening along the wall run. */
export function windowOpeningSpanMeters(navCellSize: number): number {
  return navCellSize * WINDOW_SPAN_FRACTION;
}

/**
 * The sill (bottom-of-opening) Y heights for a building. A two-storey house stacks a second-floor sill one
 * storey up — the same set openingsBuilder fills with glass, so the wall hole and the pane always line up.
 */
export function windowSillHeights(storeyHeightMeters: number, buildingHeightMeters: number): number[] {
  const sill = storeyHeightMeters * WINDOW_SILL_FRACTION;
  return buildingHeightMeters > storeyHeightMeters * 1.1 ? [sill, sill + storeyHeightMeters] : [sill];
}
