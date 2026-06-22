// T14 / T33 — persistence lane barrel: adapters + save-delta capture + schema migration +
// checkpoint/journal crash recovery.

export { partitionId, type PartitionKey, type PersistenceAdapter } from './adapter';
export { InMemoryPersistenceAdapter } from './memoryAdapter';
export { IndexedDbPersistenceAdapter, IndexedDbUnavailableError } from './indexedDbAdapter';

export {
  CURRENT_SAVE_SCHEMA_VERSION,
  MIN_MIGRATABLE_SCHEMA_VERSION,
  SchemaError,
  registerMigration,
  readSchemaVersion,
  migrateToCurrent,
  type Migration,
} from './schema';

export {
  SAVE_SCHEMA_VERSION,
  captureSaveDelta,
  writeSaveDelta,
  readSaveDelta,
  saveDeltaKey,
  migrateSaveDelta,
  validateSaveCompat,
  SaveCompatError,
  type SaveDelta,
  type SaveDeltaSource,
  type ModuleDelta,
  type ModuleFireDelta,
  type BreachRecord,
  type ContainerRecord,
  type MovedObjectRecord,
  type DroppedItemRecord,
  type CorpseRecord,
  type UtilityRecord,
  type LocalPopulationDelta,
  type MissionState,
  type IdCounterSnapshot,
} from './saveDelta';

export {
  SaveManager,
  createSaveManager,
  emptyCheckpoint,
  foldFragment,
  PartitionCorruptError,
  type SavingSettings,
  type SaveDeltaFragment,
  type CompatTarget,
  type LoadAllResult,
} from './checkpoint';
