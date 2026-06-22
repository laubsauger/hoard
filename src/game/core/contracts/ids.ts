// T42 / V26 — branded ID types. Frozen contract.
// IDs cross worker + persistence boundaries; raw object refs never do.

declare const brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type EntityId = Branded<number, 'EntityId'>;
export type ItemId = Branded<number, 'ItemId'>;
export type DistrictId = Branded<number, 'DistrictId'>;
export type SectorId = Branded<number, 'SectorId'>;
export type ChunkId = Branded<number, 'ChunkId'>;
export type NavTileId = Branded<number, 'NavTileId'>;
export type ModuleId = Branded<number, 'ModuleId'>; // StructuralModule
export type StimulusId = Branded<number, 'StimulusId'>;
export type CommandId = Branded<number, 'CommandId'>;
export type EventId = Branded<number, 'EventId'>;
export type AssetId = Branded<string, 'AssetId'>;

/** Discriminator for the minter — one monotonic counter per kind. */
export type NumericIdKind =
  | 'entity'
  | 'item'
  | 'district'
  | 'sector'
  | 'chunk'
  | 'navTile'
  | 'module'
  | 'stimulus'
  | 'command'
  | 'event';

export const NUMERIC_ID_KINDS: readonly NumericIdKind[] = [
  'entity', 'item', 'district', 'sector', 'chunk', 'navTile', 'module', 'stimulus', 'command', 'event',
];
