// T23 — inventory lane barrel.

export { ItemCatalog, type ItemDef, type ItemCategory, type ItemsSettings } from './items';
export { buildDefaultCatalog, ITEM, ITEM_CONTENT_COUNT } from './catalog';
export { rollLoot, LOOT_SOURCES, type LootSource, type LootStack, type LootEntry } from './loot';
export {
  InventorySystem,
  type ContainerType,
  type ContainerDef,
  type AccessClass,
  type Stack,
  type TransferOutcome,
  type InventoryDeps,
  type InventorySettings,
} from './inventory';
