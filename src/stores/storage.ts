// T4 / V11 — persistence storage adapter for the ONLY persisted slices (settings + session).
// Uses the platform `localStorage` in the browser; in non-DOM contexts (vitest/node, SSR) it uses an
// in-memory store. This is environment adaptation for a web API, not a gameplay fallback: it never
// invents game state, it only chooses where the persisted settings/session JSON lives.

import { createJSONStorage, type StateStorage } from 'zustand/middleware';

function createMemoryStorage(): StateStorage {
  const map = new Map<string, string>();
  return {
    getItem: (name) => (map.has(name) ? map.get(name)! : null),
    setItem: (name, value) => {
      map.set(name, value);
    },
    removeItem: (name) => {
      map.delete(name);
    },
  };
}

/** Resolve the backing web Storage once, choosing localStorage when the DOM provides it. */
export function persistStorage() {
  const backing: StateStorage =
    typeof localStorage !== 'undefined' ? (localStorage as unknown as StateStorage) : createMemoryStorage();
  return createJSONStorage(() => backing);
}

/** Stable key prefix so all persisted slices share a namespace. */
export const PERSIST_PREFIX = 'hordish';
