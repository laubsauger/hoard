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

  // ---- T20 utility scoring: per-stimulus-kind salience weights (V14) ----
  /** Utility weight applied to a heard sound stimulus when scoring what to pursue/investigate. */
  soundUtilityWeight: num({
    owner: 'perception',
    unit: 'ratio',
    doc: 'Utility weight for a heard sound stimulus in behavior scoring (V14).',
    default: 0.7,
    min: 0,
    max: 1,
  }),
  /** Utility weight applied to a sight stimulus (confirmed visual contact is the strongest pull). */
  sightUtilityWeight: num({
    owner: 'perception',
    unit: 'ratio',
    doc: 'Utility weight for a sight stimulus in behavior scoring (V14).',
    default: 1,
    min: 0,
    max: 1,
  }),
  /** Utility weight applied to nearby-agitation stimulus (herding/contagion of alertness). */
  agitationUtilityWeight: num({
    owner: 'perception',
    unit: 'ratio',
    doc: 'Utility weight for a nearby-agitation stimulus (contagion of alertness, V14).',
    default: 0.5,
    min: 0,
    max: 1,
  }),
  /** Utility weight applied to a fire stimulus — NEGATIVE pull (avoidance), magnitude only here. */
  fireAvoidUtilityWeight: num({
    owner: 'perception',
    unit: 'ratio',
    doc: 'Magnitude of fire-stimulus avoidance utility (subtracted, repels the agent, V14).',
    default: 0.9,
    min: 0,
    max: 1,
  }),
  /** Attenuated stimulus intensity at/above which it can flip a zombie out of idle/wander. */
  alertIntensityThreshold: num({
    owner: 'perception',
    unit: 'ratio',
    doc: 'Minimum attenuated stimulus intensity that can alert a zombie (V14).',
    default: 0.05,
    min: 0.001,
    max: 1,
  }),
  /** Ticks a zombie keeps investigating a stimulus origin after the stimulus fades. */
  investigateTicks: num({
    owner: 'perception',
    unit: 'ticks',
    doc: 'Ticks a zombie keeps investigating a last-known stimulus origin after it fades.',
    default: 120,
    min: 1,
    max: 6000,
    integer: true,
  }),
  /** Reach (meters) within which a zombie in pursuit transitions to attacking a target. */
  attackRangeMeters: num({
    owner: 'perception',
    unit: 'meters',
    doc: 'Reach within which a pursuing zombie transitions to its attack state.',
    default: 1.4,
    min: 0.2,
    max: 12,
  }),
});
