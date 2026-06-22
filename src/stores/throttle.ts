// T4 / V11 — snapshot publish gate. High-frequency engine->store snapshots MUST be throttled/event-gated.
// Leading-edge throttle: the first push fires immediately, subsequent pushes within the interval are
// coalesced and the latest is flushed when the interval elapses. Time source is injectable for tests.

export type Now = () => number;

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

/**
 * Wrap a publish fn so it is called at most once per `intervalMs`. Returns a gated publisher and a
 * `flushPending()` to force-deliver a coalesced value (e.g. on pause/teardown). intervalMs comes from
 * the UI config domain (V4) — callers never pass a magic number.
 */
export function createThrottledPublisher<T>(
  publish: (value: T) => void,
  intervalMs: number,
  now: Now = defaultNow,
): { push: (value: T) => void; flushPending: () => void } {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error(`throttle interval must be a non-negative finite number, got ${intervalMs}`);
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
