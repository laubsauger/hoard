// T42 / V1 / V11 — view-snapshot contract. Frozen.
// The simulation publishes small, deliberate snapshots to Zustand. React reads ONLY these,
// never per-frame world arrays. High-frequency snapshots are throttled/event-gated (V11).

import type { EntityId } from './ids';

/** Player condition for the HUD + health panel (throttled). */
export interface PlayerViewSnapshot {
  readonly entity: EntityId;
  readonly health: number;
  readonly bleeding: number;
  readonly pain: number;
  readonly hunger: number;
  readonly thirst: number;
  readonly fatigue: number;
  readonly stress: number;
  readonly encumbrance: number;
}

/** Detailed inspect of a single promoted (hero) zombie. */
export interface ZombieViewSnapshot {
  readonly entity: EntityId;
  readonly archetype: number;
  readonly health: number;
  readonly simTier: number;
  readonly severedRegions: number; // anatomyFlags bitfield mirror
}

/** Coarse horde readout for map/HUD pressure indicators — counts, not entities. */
export interface HordeViewSnapshot {
  readonly visibleCount: number;
  readonly activeCount: number;
  readonly abstractCount: number;
  readonly nearestThreatMeters: number;
}

/** Targeting reticle state (event-gated on cursor target changes, V11). */
export interface TargetingViewSnapshot {
  readonly target: EntityId | null;
  readonly obstructed: boolean;
  readonly penetrationUncertain: boolean;
  readonly structuralRisk: boolean;
}
