// Config domain: hordes. Owned by lane S. Group intent / density / shared-field thresholds (T20).
// V15 — large groups share target fields + corridor intent rather than per-agent A*.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const hordesConfig = registerDomain('hordes', {
  /** Minimum members before a cluster is treated as a flow-field-driven horde group. */
  minGroupSize: num({
    owner: 'hordes',
    unit: 'count',
    doc: 'Minimum members before a cluster is driven by a shared flow field (vs individual paths).',
    default: 8,
    min: 1,
    max: 1000,
    integer: true,
  }),
  /** Maximum members assigned to a single shared flow-field group. */
  maxGroupSize: num({
    owner: 'hordes',
    unit: 'count',
    doc: 'Maximum members assigned to a single shared flow-field group.',
    default: 512,
    min: 1,
    max: 100_000,
    integer: true,
  }),
  /** Density (agents per broad-phase cell) at/above which separation pressure intensifies (V19). */
  crowdPressureDensity: num({
    owner: 'hordes',
    unit: 'count',
    doc: 'Agents per cell at/above which crowd separation pressure intensifies (V19).',
    default: 6,
    min: 1,
    max: 64,
    integer: true,
  }),
});
