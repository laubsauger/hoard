// T4 / V29 — input store. NOT persisted in Wave 1 (only settings+session persist). Holds the live key
// bindings + sensitivities. Sensitivity defaults come from the input config domain (V4); the store keeps
// the user's current values so the engine reads intent without React owning per-frame input state (V1).

import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';
import { resolve } from '../config/spec';
import { inputConfig } from '../config/domains/input';
import type { QualityTier } from '../config/types';

/** Logical game actions remappable to physical keys (V29 full remap). */
export type InputAction =
  | 'moveUp'
  | 'moveDown'
  | 'moveLeft'
  | 'moveRight'
  | 'rotateCW'
  | 'rotateCCW'
  | 'zoomIn'
  | 'zoomOut'
  | 'interact'
  | 'attack'
  | 'reload'
  | 'inventory'
  | 'pause';

export type Bindings = Readonly<Record<InputAction, string>>;

const DEFAULT_BINDINGS: Bindings = {
  moveUp: 'KeyW',
  moveDown: 'KeyS',
  moveLeft: 'KeyA',
  moveRight: 'KeyD',
  rotateCW: 'KeyE',
  rotateCCW: 'KeyQ',
  zoomIn: 'Equal',
  zoomOut: 'Minus',
  interact: 'KeyF',
  attack: 'Mouse0',
  reload: 'KeyR',
  inventory: 'Tab',
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
    subscribeWithSelector((set) => ({
      bindings: DEFAULT_BINDINGS,
      zoomSensitivity: resolve(inputConfig.zoomSensitivity, tier),
      invertZoom: resolve(inputConfig.invertZoom, tier),
      pointerSensitivity: resolve(inputConfig.pointerSensitivity, tier),
      rebind: (action, key) => set((s) => ({ bindings: { ...s.bindings, [action]: key } })),
      setZoomSensitivity: (zoomSensitivity) => set({ zoomSensitivity }),
      setInvertZoom: (invertZoom) => set({ invertZoom }),
      setPointerSensitivity: (pointerSensitivity) => set({ pointerSensitivity }),
      resetBindings: () => set({ bindings: DEFAULT_BINDINGS }),
    })),
  );
}

export const inputStore = createInputStore();
export type InputStore = typeof inputStore;
