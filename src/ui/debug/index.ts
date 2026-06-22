// T35 — debug overlay UI barrel (NEW subdir under ui/, lane X). Plain React + CSS, no component lib.

export { DebugOverlay, type DebugOverlayProps, type DebugControlHandlers } from './DebugOverlay';
export { useDebugView } from './useDebugView';
export { useDebugOverlayToggle, DEFAULT_DEBUG_TOGGLE_KEY } from './useDebugToggle';
