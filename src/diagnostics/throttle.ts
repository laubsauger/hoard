// T35 / V11 — leading-edge throttle for collector->store snapshot publishes. Self-contained so the
// diagnostics lane stays decoupled from other lanes' utilities. Time source is injectable for tests.
// The interval comes from debug.refreshThrottleMs (V4) — callers never pass a magic number.

export type Now = () => number;

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

/**
 * Wrap a publish fn so it fires at most once per intervalMs. The first call fires immediately;
 * calls within the interval coalesce to the latest, delivered by flushPending().
 */
export function createSnapshotPublisher<T>(
  publish: (value: T) => void,
  intervalMs: number,
  now: Now = defaultNow,
): { push: (value: T) => void; flushPending: () => void } {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error(`refresh interval must be a non-negative finite number, got ${intervalMs}`);
  }
  let lastEmit = Number.NEGATIVE_INFINITY;
  let pending: { value: T } | null = null;

  const push = (value: T): void => {
    const t = now();
    if (t - lastEmit >= intervalMs) {
      lastEmit = t;
      pending = null;
      publish(value);
    } else {
      pending = { value };
    }
  };

  const flushPending = (): void => {
    if (pending) {
      lastEmit = now();
      const { value } = pending;
      pending = null;
      publish(value);
    }
  };

  return { push, flushPending };
}
