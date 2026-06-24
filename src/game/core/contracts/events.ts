// T42 / §I — event contract. Frozen. Events are facts that already occurred.
// V/§I: separate ephemeral VISUAL events from persistent WORLD mutations.

import type { EntityId, EventId, ModuleId, StimulusId } from './ids';

/** Named anatomical regions for hit resolution (V16/V17). */
export type AnatomyRegion =
  | 'head'
  | 'neck'
  | 'torsoUpper'
  | 'torsoLower'
  | 'armLeft'
  | 'armRight'
  | 'legLeft'
  | 'legRight';

/** Persistent world mutations — feed simulation authority, save deltas, AI (V9, V18). */
export type WorldEvent =
  | { readonly kind: 'hitResolved'; readonly id: EventId; readonly target: EntityId; readonly region: AnatomyRegion; readonly damage: number; readonly severed: boolean }
  | { readonly kind: 'entityDied'; readonly id: EventId; readonly entity: EntityId }
  | { readonly kind: 'structureModified'; readonly id: EventId; readonly module: ModuleId; readonly cell: number }
  | { readonly kind: 'breachCreated'; readonly id: EventId; readonly module: ModuleId; readonly cell: number }
  | { readonly kind: 'fireIgnited'; readonly id: EventId; readonly module: ModuleId; readonly cell: number }
  | { readonly kind: 'itemMoved'; readonly id: EventId; readonly item: number };

/** Ephemeral visual/audio events — feed render + audio, never persisted (§I). */
export type VisualEvent =
  | { readonly kind: 'hitReaction'; readonly id: EventId; readonly target: EntityId; readonly region: AnatomyRegion; readonly dirX: number; readonly dirZ: number; readonly energy: number }
  | { readonly kind: 'bloodSpray'; readonly id: EventId; readonly x: number; readonly y: number; readonly z: number; readonly dirX: number; readonly dirZ: number }
  | { readonly kind: 'partDetached'; readonly id: EventId; readonly target: EntityId; readonly region: AnatomyRegion }
  | { readonly kind: 'glassShatter'; readonly id: EventId; readonly x: number; readonly y: number; readonly z: number; readonly nx: number; readonly nz: number }
  | { readonly kind: 'soundEmitted'; readonly id: EventId; readonly stimulus: StimulusId; readonly x: number; readonly z: number; readonly intensity: number };

export type WorldEventKind = WorldEvent['kind'];
export type VisualEventKind = VisualEvent['kind'];
