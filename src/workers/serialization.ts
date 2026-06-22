// T33 / V23 / V26 / R12 — serialization worker boundary.
// Serialization (the CPU-heavy JSON encode of a partition's full delta) runs OFF the main thread so a
// large save never stalls the sim/render loop. This module is the WORKER LOGIC, kept as PURE functions
// driven through the frozen `serialization` WorkerRequest/WorkerResponse channel — it touches neither a
// real Worker global nor IndexedDB, so it is fully unit-testable. The thin runtime wrapper
// (installSerializationWorker) is injected with a scope + context so the same handler runs in a real
// DedicatedWorker and in tests against a fake scope. IDs (district), never object refs, cross the
// boundary (V26).

import { assertNever, type WorkerRequest, type WorkerResponse } from '@/game/core/contracts';
import type { SaveDelta } from '@/game/persistence/saveDelta';

/** Pure, deterministic serialization of a delta to a transferable string payload. */
export function serializeDelta(delta: SaveDelta): string {
  return JSON.stringify(delta);
}

/** Inverse of serializeDelta. Throws on malformed input (no silent fallback — V4). */
export function deserializeDelta(payload: string): SaveDelta {
  const parsed: unknown = JSON.parse(payload);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('serialized delta did not decode to an object');
  }
  return parsed as SaveDelta;
}

/**
 * Context the worker logic needs, injected by the host. Implementations supply the delta for a district
 * (resolved from authoritative state, snapshotted on the main thread before handoff) and persist the
 * serialized payload (async IndexedDB write on the host side). Kept abstract so tests inject in-memory.
 */
export interface SerializationContext {
  /** Resolve the delta to serialize for a district, or null if there is nothing to write. */
  resolveDistrictDelta(district: number): SaveDelta | null;
  /** Persist the serialized payload for a district (the host owns the actual async write). */
  writeSerialized(district: number, payload: string): void;
}

/**
 * Handle one serialization request. Pure with respect to its context: same request + same context state
 * yields the same response. Returns a frozen-contract WorkerResponse; an off-channel or empty request
 * resolves to an explicit `error` response rather than throwing across the boundary (V23).
 */
export function handleSerializationRequest(req: WorkerRequest, ctx: SerializationContext): WorkerResponse {
  const { requestId } = req;
  if (req.channel !== 'serialization') {
    return { requestId, channel: req.channel, kind: 'error', message: `serialization worker received '${req.channel}' request` };
  }
  if (req.kind === 'writeCheckpoint') {
    const delta = ctx.resolveDistrictDelta(req.district);
    if (delta === null) {
      return { requestId, channel: 'serialization', kind: 'error', message: `no delta to serialize for district ${req.district}` };
    }
    ctx.writeSerialized(req.district, serializeDelta(delta));
    return { requestId, channel: 'serialization', kind: 'checkpointWritten', district: req.district };
  }
  // The frozen serialization channel currently defines exactly one kind; this is unreachable by types.
  return assertNever(req, 'serialization request kind');
}

/** Minimal worker-scope surface (subset of DedicatedWorkerGlobalScope) — keeps the wiring testable. */
export interface SerializationWorkerScope {
  addEventListener(type: 'message', listener: (event: { data: WorkerRequest }) => void): void;
  postMessage(message: WorkerResponse): void;
}

/**
 * Wire the pure handler onto a worker scope. In a real DedicatedWorker the host calls this with
 * `self` and a context backed by the persistence adapter; tests call it with a fake scope + in-memory
 * context. Each inbound message produces exactly one outbound response.
 */
export function installSerializationWorker(scope: SerializationWorkerScope, ctx: SerializationContext): void {
  scope.addEventListener('message', (event) => {
    scope.postMessage(handleSerializationRequest(event.data, ctx));
  });
}
