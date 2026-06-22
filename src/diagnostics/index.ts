// T35 — diagnostics lane barrel. Collectors + percentile tracker + debug flags + overlay store + setup.

export * from './inputs';
export { PercentileRing, type FrameTimeSummary } from './percentile';
export {
  DiagnosticsCollector,
  EMPTY_SNAPSHOT,
  type DiagnosticsSnapshot,
} from './collector';
export {
  DebugFlagState,
  DEFAULT_DEBUG_FLAGS,
  type DebugFlags,
  type BooleanDebugFlag,
} from './flags';
export {
  createDebugViewStore,
  debugViewStore,
  type DebugViewState,
  type DebugViewStore,
} from './store';
export { createSnapshotPublisher, type Now } from './throttle';
export { createDiagnostics, type DiagnosticsRuntime } from './setup';
