// T4 / V11 — session store. PERSISTED (settings + session are the only persisted slices).
// subscribeWithSelector enables narrow selector subscriptions for React + engine.

import { createStore } from 'zustand/vanilla';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import { persistStorage, PERSIST_PREFIX } from './storage';

export type SessionPhase = 'boot' | 'menu' | 'loading' | 'playing' | 'paused' | 'error';

export interface SessionState {
  readonly sessionId: string;
  readonly phase: SessionPhase;
  readonly saveSlot: number | null;
  readonly startedAtMs: number;
  setPhase(phase: SessionPhase): void;
  setSaveSlot(slot: number | null): void;
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
          setPhase: (phase) => set({ phase }),
          setSaveSlot: (saveSlot) => set({ saveSlot }),
          reset: () => set({ sessionId: newSessionId(), phase: 'boot', saveSlot: null, startedAtMs: Date.now() }),
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
