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
  // ---- modification classes (T25): functional-mod / obstruction / utility tunables ----
  /** Strength added to an opening when boarded (planks resist horde pressure for a while). */
  boardStrengthBonus: num({
    owner: 'destruction', unit: 'count',
    doc: 'Structural strength added to a cell when boarded over.',
    default: 60, min: 1, max: 100000,
  }),
  /** Multiplier applied to a cell\'s max strength when reinforced/braced/welded. */
  reinforceStrengthMultiplier: num({
    owner: 'destruction', unit: 'ratio',
    doc: 'Factor a cell\'s strength is scaled by when reinforced/braced/welded (>1 hardens it).',
    default: 1.75, min: 1, max: 100,
  }),
  /** Added nav traversal cost when a cell/tile is obstructed (furniture/debris/parked vehicle). */
  obstructionNavCost: num({
    owner: 'destruction', unit: 'count',
    doc: 'Traversal-cost penalty added to a nav cell by an obstruction (furniture/debris/vehicle).',
    default: 50, min: 0, max: 1_000_000, integer: true,
  }),
  /** Intensity (0..1) of the sound Stimulus a manual modification (board/breach/obstruct) emits. */
  modificationSoundIntensity: num({
    owner: 'destruction', unit: 'ratio',
    doc: 'Intensity of the impact-class sound Stimulus emitted by a manual structural modification.',
    default: 0.5, min: 0, max: 1,
  }),
  /** Reach (m) of the sound a manual modification emits. */
  modificationSoundRadiusMeters: num({
    owner: 'destruction', unit: 'meters',
    doc: 'Reach (m) of the sound Stimulus emitted by a manual structural modification.',
    default: 30, min: 1, max: 1000,
  }),
  /** Per-tick decay of the modification sound Stimulus. */
  modificationSoundDecayPerTick: num({
    owner: 'destruction', unit: 'ratio',
    doc: 'Per-tick decay of the modification sound Stimulus (a transient impact).',
    default: 0.2, min: 0.0001, max: 1,
  }),
});
