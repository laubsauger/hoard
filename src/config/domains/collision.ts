// Config domain: collision. Owned by lane S. Broad-phase spatial-hash tunables (T12).
// V6 — collision is its own representation, separate from nav/visual/interaction; layers explicit.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const collisionConfig = registerDomain('collision', {
  /** Broad-phase uniform-grid cell edge length. Sized near the typical agent diameter. */
  broadPhaseCellSize: num({
    owner: 'collision',
    unit: 'meters',
    doc: 'Edge length of a broad-phase spatial-hash cell (square).',
    default: 2,
    min: 0.25,
    max: 16,
  }),
  /** Default agent collision radius (circle proxy) before promotion to capsule/anatomical. */
  defaultAgentRadius: num({
    owner: 'collision',
    unit: 'meters',
    doc: 'Default circle-proxy radius for a dynamic agent.',
    default: 0.35,
    min: 0.05,
    max: 2,
  }),
  /** Default agent vertical extent (height) for the vertical-bounds check. */
  defaultAgentHeight: num({
    owner: 'collision',
    unit: 'meters',
    doc: 'Default vertical extent (height) of a dynamic agent.',
    default: 1.8,
    min: 0.2,
    max: 4,
  }),
  /** Neighbour-query ring radius in cells (bounded: inspect cell + this many rings). */
  neighborRings: num({
    owner: 'collision',
    unit: 'cells',
    doc: 'Number of cell rings around the query cell inspected by a neighbour query.',
    default: 1,
    min: 0,
    max: 4,
    integer: true,
  }),
});
