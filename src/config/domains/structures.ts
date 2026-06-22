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
});
