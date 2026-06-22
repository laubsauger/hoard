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

  // ---- M2 decisive horde event (T40, §G central promise). The event's routes/pressure/outcome are
  // computed from the player's accumulated STRUCTURAL modifications, not a scripted fixed wave. ----

  /** Ticks the event builds from announce to climax (gives the player time to shape the outcome). */
  eventBuildupTicks: num({
    owner: 'hordes',
    unit: 'ticks',
    doc: 'Ticks the decisive horde event builds from announcement to climax.',
    default: 600,
    min: 1,
    max: 1_000_000,
    integer: true,
  }),
  /** Normalized pressure (0..1) at/above which the climax resolves to an overrun rather than contained. */
  climaxPressureThreshold: num({
    owner: 'hordes',
    unit: 'ratio',
    doc: 'Normalized route pressure at/above which the horde event resolves to OVERRUN vs CONTAINED.',
    default: 0.5,
    min: 0,
    max: 1,
  }),
  /** Pressure contributed by one OPEN (breached) route the horde can pour through. */
  breachRouteWeight: num({
    owner: 'hordes',
    unit: 'ratio',
    doc: 'Pressure contributed by a single open/breached route the horde can flood through.',
    default: 1,
    min: 0,
    max: 1,
  }),
  /** Multiplier (<1) applied to a route the player reinforced/boarded — stalls the mass at that point. */
  reinforceStallFactor: num({
    owner: 'hordes',
    unit: 'ratio',
    doc: 'Ambient-pressure multiplier for a reinforced/boarded route (stalls the mass, <1).',
    default: 0.25,
    min: 0,
    max: 1,
  }),
  /** Multiplier (<1) applied to a burning route — fire reroutes/stalls the horde away from it. */
  fireRerouteFactor: num({
    owner: 'hordes',
    unit: 'ratio',
    doc: 'Pressure multiplier for a route that is on fire (reroutes/stalls the horde, <1).',
    default: 0.3,
    min: 0,
    max: 1,
  }),
  /** Baseline ambient pressure per intact (non-reinforced) route — the horde pressing at weak points. */
  baseRoutePressure: num({
    owner: 'hordes',
    unit: 'ratio',
    doc: 'Baseline ambient pressure per intact, non-reinforced route (horde pressing at weak points).',
    default: 0.2,
    min: 0,
    max: 1,
  }),
});
