// Shared window-opening geometry. The house wall PUNCH (houseBuilder) and the glass / void / frame FILL
// (openingsBuilder) both derive their opening from these helpers, so the hole cut through the wall and the
// pane that sits in it are guaranteed identical (V26 determinism) — no duplicated literals to drift apart.
// Render-only geometry (no sim/passability impact); the cells themselves come from windowPlacements().

// Believable residential proportions derived from the storey height (V26 — both builders consume these helpers
// so the wall punch + glass stay aligned). At the default ~3 m storey these resolve to a sill ~0.9 m, a head
// ~2.1 m and a ~1.2 m opening — a window centred at chest/eye height rather than floating high under the eave.
/** Window opening height as a fraction of ONE storey's wall height (head − sill ≈ 1.2 m at a 3 m storey). */
const WINDOW_HEIGHT_FRACTION = 0.4;
/** Ground-floor sill height as a fraction of one storey's wall height (≈ 0.9 m at a 3 m storey). */
const WINDOW_SILL_FRACTION = 0.3;
/** Horizontal opening width as a fraction of the nav-cell run. Kept narrow so the opening + its painted frame
 *  trim (which laps ~0.08 m past each jamb) sit comfortably WITHIN the cell with a real jamb reveal on each
 *  side — the glass never touches the cell edge / its neighbour. */
const WINDOW_SPAN_FRACTION = 0.7;

/** The wall shell thickness: the configured panel thickness, never wider than one nav cell (a thin shell). */
export function wallShellThicknessMeters(wallPanelThicknessMeters: number, navCellSize: number): number {
  return Math.min(wallPanelThicknessMeters, navCellSize);
}

/** Glass pane depth (house polish #5): a THIN pane CENTRED in the opening — not a full-wall-depth slab. Thin
 *  enough that its faces never approach the wall jamb / frame trim (kills the coincident-face z-fight) while the
 *  opening itself stays a real see-through hole punched through the full wall depth. */
export const WINDOW_GLASS_DEPTH_METERS = 0.03;

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
