// Config domain: destruction. Owned by lane S. Damage + breach + debris behaviour (T13/T25).
// V18 — persistent rubble is compact state; same breach state feeds render/collision/path/save.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const destructionConfig = registerDomain('destruction', {
  /** Fraction of a cell's strength that, once removed, crosses the breach threshold. */
  breachThresholdRatio: num({
    owner: 'destruction',
    unit: 'ratio',
    doc: 'Fraction of original strength that must be destroyed before a cell breaches.',
    default: 1,
    min: 0.1,
    max: 1,
  }),
  /** Irregularity seed jitter applied to breach footprints so holes hide cell shape (V30). */
  breachIrregularity: num({
    owner: 'destruction',
    unit: 'ratio',
    doc: 'Probability a neighbouring fracture-family cell joins the breach footprint (V30 irregular holes).',
    default: 0.5,
    min: 0,
    max: 1,
  }),
  /** Ticks detached debris stays an active physics body before settling to cheap static (V18). */
  debrisActiveTicks: num({
    owner: 'destruction',
    unit: 'ticks',
    doc: 'Ticks debris stays active physics before settling to cheap static/instanced.',
    default: 90,
    min: 0,
    max: 6000,
    integer: true,
  }),
});
