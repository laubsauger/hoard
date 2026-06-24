// T4 / T50 / V11 / V29 — input store. PERSISTED (V11 persists session + settings + input). Holds the live
// rebindable keymap + sensitivities. Sensitivity defaults come from the input config domain (V4); the store
// keeps the user's current values so the engine reads intent without React owning per-frame input state (V1).
// The rebinding settings sub-panel writes here; the persisted bindings + sensitivities survive reloads.

import { createStore } from 'zustand/vanilla';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import { persistStorage, PERSIST_PREFIX } from './storage';
import { resolve } from '../config/spec';
import { inputConfig } from '../config/domains/input';
import type { QualityTier } from '../config/types';

/** Logical game actions remappable to physical keys (V29 full remap). */
export type InputAction =
  | 'moveUp'
  | 'moveDown'
  | 'moveLeft'
  | 'moveRight'
  | 'sprint'
  | 'sneak'
  | 'rotateCW'
  | 'rotateCCW'
  | 'zoomIn'
  | 'zoomOut'
  | 'interact'
  | 'attack'
  | 'reload'
  | 'inventory'
  | 'emote'
  | 'pause';

export type Bindings = Readonly<Record<InputAction, string>>;

/** Display order + grouping for the rebinding UI (movement, camera, then action keys). */
export const INPUT_ACTIONS: readonly InputAction[] = [
  'moveUp',
  'moveDown',
  'moveLeft',
  'moveRight',
  'sprint',
  'sneak',
  'rotateCW',
  'rotateCCW',
  'zoomIn',
  'zoomOut',
  'attack',
  'interact',
  'reload',
  'inventory',
  'emote',
  'pause',
];

/** Human-readable labels for the logical actions (rebinding UI). */
export const INPUT_ACTION_LABELS: Readonly<Record<InputAction, string>> = {
  moveUp: 'Move up',
  moveDown: 'Move down',
  moveLeft: 'Move left',
  moveRight: 'Move right',
  sprint: 'Sprint',
  sneak: 'Sneak',
  rotateCW: 'Rotate camera CW',
  rotateCCW: 'Rotate camera CCW',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  attack: 'Fire / attack',
  interact: 'Interact',
  reload: 'Reload',
  inventory: 'Inventory',
  emote: 'Emote (push-up)',
  pause: 'Pause',
};

/**
 * Friendly label for a physical key/mouse code (`KeyboardEvent.code` or `Mouse<button>`), shown on the
 * rebind buttons. Pure + presentation-only; no game state.
 */
export function formatKeyCode(code: string): string {
  if (code === 'Mouse0') return 'LMB';
  if (code === 'Mouse1') return 'MMB';
  if (code === 'Mouse2') return 'RMB';
  if (code.startsWith('Mouse')) return `Mouse${code.slice(5)}`;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return `${code.slice(5)} ↑`;
  return code;
}

const DEFAULT_BINDINGS: Bindings = {
  moveUp: 'KeyW',
  moveDown: 'KeyS',
  moveLeft: 'KeyA',
  moveRight: 'KeyD',
  sprint: 'ShiftLeft',
  sneak: 'ControlLeft',
  rotateCW: 'KeyE',
  rotateCCW: 'KeyQ',
  zoomIn: 'Equal',
  zoomOut: 'Minus',
  interact: 'KeyF',
  attack: 'Mouse0',
  reload: 'KeyR',
  inventory: 'Tab',
  emote: 'KeyG', // T127: the "emote key" — fires the one-shot push-up; a single emote for now, can grow later
  pause: 'Escape',
};

export interface InputState {
  readonly bindings: Bindings;
  readonly zoomSensitivity: number;
  readonly invertZoom: boolean;
  readonly pointerSensitivity: number;
  rebind(action: InputAction, key: string): void;
  setZoomSensitivity(v: number): void;
  setInvertZoom(v: boolean): void;
  setPointerSensitivity(v: number): void;
  resetBindings(): void;
}

export function createInputStore(tier: QualityTier = 'desktop-high') {
  return createStore<InputState>()(
    subscribeWithSelector(
      persist(
        (set) => ({
          bindings: DEFAULT_BINDINGS,
          zoomSensitivity: resolve(inputConfig.zoomSensitivity, tier),
          invertZoom: resolve(inputConfig.invertZoom, tier),
          pointerSensitivity: resolve(inputConfig.pointerSensitivity, tier),
          rebind: (action, key) => set((s) => ({ bindings: { ...s.bindings, [action]: key } })),
          setZoomSensitivity: (zoomSensitivity) => set({ zoomSensitivity }),
          setInvertZoom: (invertZoom) => set({ invertZoom }),
          setPointerSensitivity: (pointerSensitivity) => set({ pointerSensitivity }),
          resetBindings: () => set({ bindings: DEFAULT_BINDINGS }),
        }),
        {
          name: `${PERSIST_PREFIX}:input`,
          // v3 (T127): added the `emote` binding — the migrate below backfills it from DEFAULT_BINDINGS so a
          // persisted v2 keymap resolves `emote` to its default instead of leaving it undefined.
          version: 3,
          storage: persistStorage(),
          // V29: backfill any binding missing from older persisted state (e.g. the added `sprint` key) from
          // the defaults so every logical action always resolves to a physical key (no undefined binding).
          migrate: (persisted) => {
            const st = (persisted ?? {}) as Partial<InputState>;
            return { ...st, bindings: { ...DEFAULT_BINDINGS, ...(st.bindings ?? {}) } };
          },
          // V11 — persist user preferences only; action functions are re-supplied by the creator.
          partialize: (s) => ({
            bindings: s.bindings,
            zoomSensitivity: s.zoomSensitivity,
            invertZoom: s.invertZoom,
            pointerSensitivity: s.pointerSensitivity,
          }),
        },
      ),
    ),
  );
}

export const inputStore = createInputStore();
export type InputStore = typeof inputStore;
