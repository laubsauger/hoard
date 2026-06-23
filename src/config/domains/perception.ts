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
  /** Zombie field-of-view (full cone angle, degrees). A zombie only SEES the player within this cone of its
   *  facing — not 360° (V14). 360 = omnidirectional. */
  fieldOfViewDegrees: num({
    owner: 'perception',
    unit: 'degrees',
    doc: 'Full vision-cone angle a zombie can see within (centred on its heading). Not 360° by default.',
    default: 120,
    min: 10,
    max: 360,
  }),
  /** Player vision cone (full angle, degrees) — the Project-Zomboid-style forward awareness wedge used by
   *  the dev overlay (and, later, fog-of-war reveal). */
  playerFieldOfViewDegrees: num({
    owner: 'perception',
    unit: 'degrees',
    doc: 'Full angle of the player forward vision cone (overlay + future fog-of-war reveal).',
    default: 100,
    min: 10,
    max: 360,
  }),
  /** Player vision range (m) for the forward cone overlay. */
  playerVisionRange: num({
    owner: 'perception',
    unit: 'meters',
    doc: 'Range of the player forward vision cone (overlay + future reveal).',
    default: 18,
    min: 1,
    max: 200,
  }),
  /** Sound reaching the horde through a wall is multiplied by this (V28 occlusion). 1 = no muffle. */
  soundWallOcclusion: num({
    owner: 'perception',
    unit: 'ratio',
    doc: 'Intensity multiplier for a sound whose path to the horde is blocked by structure (V28).',
    default: 0.3,
    min: 0,
    max: 1,
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
  /**
   * Cap on the number of DISTINCT active target cells that each get their own shared flow field per tick
   * (V14/V15). Sound is localized perception, so the horde no longer follows one global field — each zombie
   * picks its own target (seen player / loudest heard sound) and zombies sharing a target cell share one
   * cached field. This bounds per-tick flow-field cost: the most-pursued targets win the budget; zombies
   * whose target falls outside it idle/wander until a more-pursued target frees a slot. Must stay <= the
   * navigation flowFieldCacheSize so the per-tick fields never thrash the LRU cache.
   */
  maxSimultaneousFlowFields: num({
    owner: 'perception',
    unit: 'count',
    doc: 'Max distinct per-tick target cells that get their own shared flow field (caps recompute cost, V15).',
    default: 4,
    min: 1,
    max: 32,
    integer: true,
  }),
});
