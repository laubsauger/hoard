// Config domain: perception. Owned by lane S. Stimulus-driven sensing ranges (T20, feeds T10 tiering).
// V14 — zombies never receive omniscient player coords; perception is stimulus-driven only.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const perceptionConfig = registerDomain('perception', {
  /** Base line-of-sight range for a default archetype. */
  sightRange: num({
    owner: 'perception',
    unit: 'meters',
    doc: 'Base line-of-sight detection range for a default archetype.',
    default: 24,
    min: 1,
    max: 200,
  }),
  /** Base hearing range for a default-intensity stimulus. */
  hearingRange: num({
    owner: 'perception',
    unit: 'meters',
    doc: 'Base hearing range for a default-intensity sound stimulus.',
    default: 40,
    min: 1,
    max: 500,
  }),
  /** Threat contribution (0..1) of a confirmed visible player within sight range. */
  visibleThreatWeight: num({
    owner: 'perception',
    unit: 'ratio',
    doc: 'Threat contribution of a confirmed visible threat within sight range.',
    default: 0.8,
    min: 0,
    max: 1,
  }),
});
