// T14 — persistence lane barrel: adapters + save-delta capture.

export { partitionId, type PartitionKey, type PersistenceAdapter } from './adapter';
export { InMemoryPersistenceAdapter } from './memoryAdapter';
export { IndexedDbPersistenceAdapter, IndexedDbUnavailableError } from './indexedDbAdapter';
export {
  SAVE_SCHEMA_VERSION,
  captureSaveDelta,
  writeSaveDelta,
  readSaveDelta,
  saveDeltaKey,
  SaveCompatError,
  type SaveDelta,
  type ModuleDelta,
  type SaveDeltaSource,
} from './saveDelta';
