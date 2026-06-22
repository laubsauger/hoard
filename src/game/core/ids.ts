// T3 / V26 — deterministic ID minter. One monotonic counter per kind.
// Seedable so recorded command sequences replay to identical IDs (deterministic-sim test layer).

import { NUMERIC_ID_KINDS, type NumericIdKind } from './contracts/ids';

export class IdFactory {
  private readonly counters: Record<NumericIdKind, number>;

  constructor(seed = 0) {
    if (!Number.isInteger(seed) || seed < 0) {
      throw new Error(`IdFactory seed must be a non-negative integer, got ${seed}`);
    }
    this.counters = Object.fromEntries(NUMERIC_ID_KINDS.map((k) => [k, seed])) as Record<NumericIdKind, number>;
  }

  /** Mint the next id for a kind. Generic over the branded return type. */
  next<T extends number>(kind: NumericIdKind): T {
    const value = this.counters[kind];
    this.counters[kind] = value + 1;
    return value as T;
  }

  /** Current counter (next id to be issued) for diagnostics + save serialization. */
  peek(kind: NumericIdKind): number {
    return this.counters[kind];
  }

  /** Restore counters from a save so post-load ids never collide with pre-save ids. */
  restore(state: Readonly<Record<NumericIdKind, number>>): void {
    for (const k of NUMERIC_ID_KINDS) {
      const v = state[k];
      if (!Number.isInteger(v) || v < 0) throw new Error(`invalid restored counter ${k}=${v}`);
      this.counters[k] = v;
    }
  }

  /** Snapshot counters for save serialization. */
  snapshot(): Record<NumericIdKind, number> {
    return { ...this.counters };
  }
}
