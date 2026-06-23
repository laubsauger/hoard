// Config domain: structures. Owned by lane S. Sparse StructuralModule occupancy + material (T13).
// V4 — material strengths are typed content, not magic numbers buried in destruction logic.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const structuresConfig = registerDomain('structures', {
  /** Structural occupancy-cell edge length (object-local sparse grid). */
  cellSize: num({
    owner: 'structures',
    unit: 'meters',
    doc: 'Edge length of a structural occupancy cell (object-local sparse grid).',
    default: 1,
    min: 0.25,
    max: 4,
  }),
  /** Default per-cell strength (hit points) for a generic wall cell. */
  defaultCellStrength: num({
    owner: 'structures',
    unit: 'count',
    doc: 'Default structural strength (hit points) of an occupied cell.',
    default: 100,
    min: 1,
    max: 100_000,
  }),
  /** Cells in the same fracture family within this radius participate in an irregular breach. */
  breachSpreadRadius: num({
    owner: 'structures',
    unit: 'cells',
    doc: 'Radius (in cells) over which a breach irregularly spreads within a fracture family.',
    default: 1,
    min: 0,
    max: 8,
    integer: true,
  }),

  // ---- T46/T59/T60 doors + context-sensitive interaction (V4 — no magic placement/size/range) ----
  /** Door leaf width as a fraction of its opening (nav) cell — leaves a sliver of frame on each side. */
  doorLeafWidthFraction: num({
    owner: 'structures',
    unit: 'ratio',
    doc: 'Door leaf width as a fraction of its opening cell width (rest is frame reveal).',
    default: 0.9,
    min: 0.4,
    max: 1,
  }),
  /** Door leaf height as a fraction of the wall height — the header/lintel fills the gap above. */
  doorLeafHeightFraction: num({
    owner: 'structures',
    unit: 'ratio',
    doc: 'Door leaf height as a fraction of wall height (header/lintel caps the opening above it).',
    default: 0.82,
    min: 0.4,
    max: 1,
  }),
  /** Door leaf thickness (m) — a flat slab lying in the wall plane. */
  doorLeafThicknessMeters: num({
    owner: 'structures',
    unit: 'meters',
    doc: 'Thickness of a door leaf slab (lies in the wall plane).',
    default: 0.08,
    min: 0.02,
    max: 0.4,
  }),
  /** Door/window frame member thickness (m) — posts, lintel, sill. */
  openingFrameThicknessMeters: num({
    owner: 'structures',
    unit: 'meters',
    doc: 'Thickness of door/window frame members (posts, lintel, sill).',
    default: 0.14,
    min: 0.04,
    max: 0.5,
  }),
  /** Angle (radians) a door leaf swings open about its hinge edge (≈90°). */
  doorOpenSwingRadians: num({
    owner: 'structures',
    unit: 'radians',
    doc: 'Angle a door leaf swings open about its hinge edge (≈90°).',
    default: 1.5708,
    min: 0.2,
    max: 3.14159,
  }),
  /** How fast a door leaf rotates toward its open/closed target (radians/second of swing animation). */
  doorSwingSpeedRadiansPerSecond: num({
    owner: 'structures',
    unit: 'ratio',
    doc: 'Angular speed the rendered door leaf approaches its open/closed target (render-only easing).',
    default: 8,
    min: 0.5,
    max: 50,
  }),
  /** Player reach (m) within which an interactable target is offered (context prompt + wheel). */
  interactionRangeMeters: num({
    owner: 'structures',
    unit: 'meters',
    doc: 'Player distance within which the nearest interactable is offered (prompt + interaction wheel).',
    default: 3.5,
    min: 0.5,
    max: 12,
  }),
});
