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

  // ---- B4 hard min-spacing penetration resolution (V19) ----
  // After the soft steering integrate, visible-tier agents are pushed apart so they never visibly
  // interpenetrate. Min spacing is tied to body radius (not larger) so doorway queueing/compression
  // still flows; the abstract tier is exempt so a compressed off-screen horde may overlap.
  /** Min centre-to-centre spacing as a multiple of the two agents' summed radii (1 = bodies just touch). */
  minSpacingScale: num({
    owner: 'collision',
    unit: 'ratio',
    doc: 'Minimum centre spacing as a multiple of summed agent radii in penetration resolution (1 = bodies just touch). Tied to body size so chokepoint flow is preserved (V19).',
    default: 1,
    min: 0.5,
    max: 2,
  }),
  /** Relaxation passes the penetration-resolution step runs each tick (more = tighter but costlier). */
  separationIterations: num({
    owner: 'collision',
    unit: 'count',
    doc: 'Relaxation iterations of the hard min-spacing penetration-resolution pass per tick.',
    default: 2,
    min: 0,
    max: 8,
    integer: true,
  }),
  /** Highest sim tier (inclusive) that participates in hard min-spacing resolution. */
  maxResolvedSimTier: num({
    owner: 'collision',
    unit: 'count',
    doc: 'Highest sim tier (inclusive, lower = more fidelity) resolved by min-spacing. Default 2 covers hero/active/visible; abstract (3) is exempt so a compressed horde may overlap (V19).',
    default: 2,
    min: 0,
    max: 3,
    integer: true,
  }),
});
