// Config domain: zombies. Owned by lane S. SoA capacity + tier-assignment thresholds (T8/T10).
// V13 — tier assignment depends on distance/visibility/threat/camera/target/damage/attack/perf budget.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const zombiesConfig = registerDomain('zombies', {
  /** SoA backing-store capacity (max simultaneously addressable zombies in a loaded set). */
  capacity: num({
    owner: 'zombies',
    unit: 'count',
    doc: 'Maximum simultaneously addressable zombies in the SoA store.',
    default: 5000,
    min: 1,
    max: 200_000,
    integer: true,
    tiers: { 'mobile-webgpu': 1500 },
  }),
  /** Distance below which a zombie is a Tier-0 hero candidate (full fidelity). */
  heroDistance: num({
    owner: 'zombies',
    unit: 'meters',
    doc: 'Max distance for a Tier-0 hero candidate.',
    default: 12,
    min: 1,
    max: 64,
  }),
  /** Distance below which a zombie is at most Tier-1 active-crowd. */
  activeDistance: num({
    owner: 'zombies',
    unit: 'meters',
    doc: 'Max distance for a Tier-1 active-crowd candidate.',
    default: 40,
    min: 4,
    max: 200,
  }),
  /** Distance below which a zombie is at most Tier-2 visible-horde; beyond is Tier-3 abstract. */
  hordeDistance: num({
    owner: 'zombies',
    unit: 'meters',
    doc: 'Max distance for a Tier-2 visible-horde candidate; beyond becomes Tier-3 abstract.',
    default: 120,
    min: 8,
    max: 1000,
  }),
  /** Threat level (0..1) at/above which a zombie is promoted one tier toward hero. */
  threatPromoteLevel: num({
    owner: 'zombies',
    unit: 'ratio',
    doc: 'Threat level at/above which a zombie is promoted one tier.',
    default: 0.6,
    min: 0,
    max: 1,
  }),
  /** Camera-importance (0..1) at/above which a zombie is promoted one tier. */
  cameraPromoteLevel: num({
    owner: 'zombies',
    unit: 'ratio',
    doc: 'Camera-importance at/above which a zombie is promoted one tier.',
    default: 0.7,
    min: 0,
    max: 1,
  }),
  /** Perf budget (0..1) below which discretionary promotions are suppressed (demotion pressure). */
  perfBudgetFloor: num({
    owner: 'zombies',
    unit: 'ratio',
    doc: 'Available perf budget below which discretionary hero promotions are suppressed.',
    default: 0.2,
    min: 0,
    max: 1,
  }),
});
