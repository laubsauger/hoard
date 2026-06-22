// T42 / §I — command contract. Frozen. UI issues intent; engine validates; may fail with explicit reason.
// Closed discriminated union — extending it is a coordinated edit, never a mid-wave lane change.

import type { CommandId, EntityId, ItemId, ModuleId } from './ids';

/** Where an item lives — a container is addressed by owning entity + named slot. */
export interface ContainerRef {
  readonly entity: EntityId;
  readonly container: string;
}

export type StructureOp = 'open' | 'close' | 'lock' | 'unlock' | 'board' | 'reinforce' | 'breach';

export type Command =
  | { readonly kind: 'equip'; readonly id: CommandId; readonly entity: EntityId; readonly item: ItemId; readonly slot: string }
  | { readonly kind: 'moveItem'; readonly id: CommandId; readonly item: ItemId; readonly from: ContainerRef; readonly to: ContainerRef; readonly count: number }
  | { readonly kind: 'craft'; readonly id: CommandId; readonly entity: EntityId; readonly recipe: string }
  | { readonly kind: 'confirmAction'; readonly id: CommandId; readonly entity: EntityId; readonly action: string }
  | { readonly kind: 'changeSetting'; readonly id: CommandId; readonly key: string; readonly value: number | boolean | string }
  | { readonly kind: 'selectTarget'; readonly id: CommandId; readonly entity: EntityId; readonly target: EntityId | null }
  | { readonly kind: 'modifyStructure'; readonly id: CommandId; readonly module: ModuleId; readonly cell: number; readonly op: StructureOp };

export type CommandKind = Command['kind'];

/** Result of validating/applying a command. Failure carries an explicit machine-readable reason. */
export type CommandResult =
  | { readonly ok: true; readonly id: CommandId }
  | { readonly ok: false; readonly id: CommandId; readonly reason: string };
