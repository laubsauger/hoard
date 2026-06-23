// T4 / V11 — session store. PERSISTED (settings + session are the only persisted slices).
// subscribeWithSelector enables narrow selector subscriptions for React + engine.

import { createStore } from 'zustand/vanilla';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import { persistStorage, PERSIST_PREFIX } from './storage';

// 'dead' = the player's health reached 0 — the lethal game-over state. The sim is left runnable (the
// horde keeps milling) but player control is halted; the UI shows a game-over screen and offers restart.
export type SessionPhase = 'boot' | 'menu' | 'loading' | 'playing' | 'paused' | 'dead' | 'error';

// T49 / V12 — single-player time-scale (slowdown). 1 == real-time; the rAF loop multiplies the frame dt
// by this when stepping the sim. These are UI-tier presentation governors (no gameplay config domain
// owns them), so they live here as named constants — never as inline magic numbers.
export const TIME_SCALE_REALTIME = 1;
export const TIME_SCALE_MIN = 0.1;
export const TIME_SCALE_MAX = 1;
/** Discrete slowdown choices surfaced in the pause menu (real-time → quarter speed). */
export const TIME_SCALE_PRESETS: readonly number[] = [1, 0.5, 0.25];

/** Clamp a requested time-scale into the supported slowdown band (no silent invalid values). */
export function clampTimeScale(v: number): number {
  if (!Number.isFinite(v)) throw new Error(`timeScale must be a finite number, got ${v}`);
  return Math.min(TIME_SCALE_MAX, Math.max(TIME_SCALE_MIN, v));
}

/**
 * T49 / V12 — pure loop gate. Returns the simulation dt the rAF loop should advance THIS frame:
 * zero while paused (the sim HALTS — not just the UI), otherwise the real frame dt scaled by the
 * single-player time-scale. The renderer keeps drawing when paused; only `runtime.update` is skipped.
 */
export function simStepDt(frameDt: number, paused: boolean, timeScale: number): number {
  if (paused) return 0;
  return frameDt * clampTimeScale(timeScale);
}

export interface SessionState {
  readonly sessionId: string;
  readonly phase: SessionPhase;
  readonly saveSlot: number | null;
  readonly startedAtMs: number;
  // T49 — authoritative pause + slowdown, shared with the engine loop (single source of truth).
  readonly paused: boolean;
  readonly timeScale: number;
  setPhase(phase: SessionPhase): void;
  setSaveSlot(slot: number | null): void;
  setPaused(paused: boolean): void;
  togglePause(): void;
  setTimeScale(scale: number): void;
  reset(): void;
}

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  throw new Error('crypto.randomUUID unavailable — cannot mint a session id');
}

export function createSessionStore() {
  return createStore<SessionState>()(
    subscribeWithSelector(
      persist(
        (set) => ({
          sessionId: newSessionId(),
          phase: 'boot',
          saveSlot: null,
          startedAtMs: Date.now(),
          paused: false,
          timeScale: TIME_SCALE_REALTIME,
          setPhase: (phase) => set({ phase }),
          setSaveSlot: (saveSlot) => set({ saveSlot }),
          setPaused: (paused) => set({ paused }),
          togglePause: () => set((s) => ({ paused: !s.paused })),
          setTimeScale: (scale) => set({ timeScale: clampTimeScale(scale) }),
          reset: () =>
            set({
              sessionId: newSessionId(),
              phase: 'boot',
              saveSlot: null,
              startedAtMs: Date.now(),
              paused: false,
              timeScale: TIME_SCALE_REALTIME,
            }),
        }),
        {
          name: `${PERSIST_PREFIX}:session`,
          version: 1,
          storage: persistStorage(),
          // Persist identity + chosen slot only; transient phase resets on reload.
          partialize: (s) => ({ sessionId: s.sessionId, saveSlot: s.saveSlot }),
        },
      ),
    ),
  );
}

export const sessionStore = createSessionStore();
export type SessionStore = typeof sessionStore;
