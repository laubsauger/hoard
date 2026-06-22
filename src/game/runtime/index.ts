// T41 — runtime lane barrel: the GATE-0 GameRuntime + its save record.

export {
  GameRuntime,
  type GameRuntimeOptions,
  type DrainedEvents,
} from './gameRuntime';
export {
  RUNTIME_SAVE_KEY,
  RUNTIME_SAVE_SCHEMA_VERSION,
  type RuntimeSave,
  type PopulationEntry,
  type PlayerSave,
} from './saveRecord';
