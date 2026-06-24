// T4 / V11 — React bindings. Every hook REQUIRES a selector argument so components subscribe to the
// smallest practical slice (V11: never call a store hook without a selector in production UI).

import { useStore } from 'zustand';
import { sessionStore, type SessionState } from './session';
import { settingsStore, type SettingsState } from './settings';
import { uiStore, type UiState } from './ui';
import { playerViewStore, type PlayerViewState } from './playerView';
import { inventoryViewStore, type InventoryViewState } from './inventoryView';
import { craftingViewStore, type CraftingViewState } from './craftingView';
import { mapViewStore, type MapViewState } from './mapView';
import { noiseViewStore, type NoiseViewState } from './noiseView';
import { inputStore, type InputState } from './input';
import { interactionSelectStore, type InteractionSelectState } from './interactionSelect';
import { diagnosticsStore, type DiagnosticsState } from './diagnostics';

export const useSession = <T>(selector: (s: SessionState) => T): T => useStore(sessionStore, selector);
export const useSettings = <T>(selector: (s: SettingsState) => T): T => useStore(settingsStore, selector);
export const useUi = <T>(selector: (s: UiState) => T): T => useStore(uiStore, selector);
export const usePlayerView = <T>(selector: (s: PlayerViewState) => T): T => useStore(playerViewStore, selector);
export const useInventoryView = <T>(selector: (s: InventoryViewState) => T): T =>
  useStore(inventoryViewStore, selector);
export const useCraftingView = <T>(selector: (s: CraftingViewState) => T): T =>
  useStore(craftingViewStore, selector);
export const useMapView = <T>(selector: (s: MapViewState) => T): T => useStore(mapViewStore, selector);
export const useNoiseView = <T>(selector: (s: NoiseViewState) => T): T => useStore(noiseViewStore, selector);
export const useInput = <T>(selector: (s: InputState) => T): T => useStore(inputStore, selector);
export const useInteractionSelect = <T>(selector: (s: InteractionSelectState) => T): T =>
  useStore(interactionSelectStore, selector);
export const useDiagnostics = <T>(selector: (s: DiagnosticsState) => T): T => useStore(diagnosticsStore, selector);
