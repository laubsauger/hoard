// T4 — stores barrel. Singletons + factories (factories used in tests for isolated instances).

export {
  sessionStore,
  createSessionStore,
  type SessionState,
  type SessionPhase,
  type SessionStore,
} from './session';
export {
  settingsStore,
  createSettingsStore,
  type SettingsState,
  type SettingsStore,
} from './settings';
export { uiStore, createUiStore, type UiState, type PanelId, type UiStore } from './ui';
export {
  playerViewStore,
  createPlayerViewStore,
  createPlayerSnapshotGate,
  type PlayerViewState,
  type PlayerViewStore,
} from './playerView';
export {
  inventoryViewStore,
  createInventoryViewStore,
  type InventoryViewState,
  type ContainerView,
  type InventorySlotView,
  type InventoryViewStore,
} from './inventoryView';
export {
  craftingViewStore,
  createCraftingViewStore,
  type CraftingViewState,
  type CraftActionView,
  type CraftingViewStore,
} from './craftingView';
export {
  mapViewStore,
  createMapViewStore,
  createHordeSnapshotGate,
  type MapViewState,
  type MapMarker,
  type MapViewStore,
} from './mapView';
export {
  inputStore,
  createInputStore,
  type InputState,
  type InputAction,
  type Bindings,
  type InputStore,
} from './input';
export {
  diagnosticsStore,
  createDiagnosticsStore,
  createDiagnosticsGate,
  ZERO_COUNTERS,
  type DiagnosticsState,
  type DiagnosticsCounters,
  type DiagnosticsStore,
} from './diagnostics';
export { createThrottledPublisher, type Now } from './throttle';
export { persistStorage, PERSIST_PREFIX } from './storage';
