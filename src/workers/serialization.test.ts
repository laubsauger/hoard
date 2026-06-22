// T33 tests — serialization worker boundary (R12/V26): the pure handler over the frozen `serialization`
// channel, round-trip (de)serialization, off-channel + empty-delta error responses, and the injectable
// install wiring driven by a FAKE worker scope (no real Worker / IndexedDB needed).

import { describe, it, expect } from 'vitest';
import {
  serializeDelta,
  deserializeDelta,
  handleSerializationRequest,
  installSerializationWorker,
  type SerializationContext,
  type SerializationWorkerScope,
} from './serialization';
import { captureSaveDelta, type SaveDelta } from '@/game/persistence/saveDelta';
import type { WorkerRequest, WorkerResponse } from '@/game/core/contracts';

const WORLD = 'base-1.0.0';

function districtDelta(district: number): SaveDelta {
  return captureSaveDelta({
    worldVersion: WORLD,
    partition: { district, sector: -1 },
    capturedAtTick: 7,
    breaches: [{ module: 1, cell: 4 }],
  });
}

class FakeContext implements SerializationContext {
  readonly written = new Map<number, string>();
  constructor(private readonly deltas: Map<number, SaveDelta>) {}
  resolveDistrictDelta(district: number): SaveDelta | null {
    return this.deltas.get(district) ?? null;
  }
  writeSerialized(district: number, payload: string): void {
    this.written.set(district, payload);
  }
}

describe('serialization (de)serialize round-trip', () => {
  it('serializes a delta to a string and back', () => {
    const delta = districtDelta(3);
    const payload = serializeDelta(delta);
    expect(typeof payload).toBe('string');
    expect(deserializeDelta(payload)).toEqual(delta);
  });

  it('throws on malformed payloads rather than inventing one (V4)', () => {
    expect(() => deserializeDelta('not json')).toThrow();
    expect(() => deserializeDelta('42')).toThrow();
  });
});

describe('handleSerializationRequest (pure)', () => {
  it('serializes the resolved delta and reports checkpointWritten', () => {
    const ctx = new FakeContext(new Map([[5, districtDelta(5)]]));
    const req: WorkerRequest = { requestId: 1, channel: 'serialization', kind: 'writeCheckpoint', district: 5 };
    const res = handleSerializationRequest(req, ctx);
    expect(res).toEqual({ requestId: 1, channel: 'serialization', kind: 'checkpointWritten', district: 5 });
    expect(deserializeDelta(ctx.written.get(5)!)).toEqual(districtDelta(5));
  });

  it('returns an explicit error when there is no delta for the district', () => {
    const ctx = new FakeContext(new Map());
    const req: WorkerRequest = { requestId: 2, channel: 'serialization', kind: 'writeCheckpoint', district: 9 };
    const res = handleSerializationRequest(req, ctx);
    expect(res.kind).toBe('error');
    expect(res.channel).toBe('serialization');
  });

  it('rejects an off-channel request without throwing across the boundary', () => {
    const ctx = new FakeContext(new Map());
    const req: WorkerRequest = { requestId: 3, channel: 'nav', kind: 'buildFlowField', navRevision: 1, targetCell: 0 };
    const res = handleSerializationRequest(req, ctx);
    expect(res.kind).toBe('error');
    expect(res.requestId).toBe(3);
  });
});

describe('installSerializationWorker (fake scope)', () => {
  it('wires inbound messages to the handler and posts one response each', () => {
    const ctx = new FakeContext(new Map([[1, districtDelta(1)]]));
    const responses: WorkerResponse[] = [];
    let listener: ((event: { data: WorkerRequest }) => void) | null = null;
    const scope: SerializationWorkerScope = {
      addEventListener: (_t, l) => { listener = l; },
      postMessage: (m) => { responses.push(m); },
    };
    installSerializationWorker(scope, ctx);
    expect(listener).not.toBeNull();

    listener!({ data: { requestId: 1, channel: 'serialization', kind: 'writeCheckpoint', district: 1 } });
    expect(responses).toHaveLength(1);
    expect(responses[0]!.kind).toBe('checkpointWritten');
    expect(ctx.written.has(1)).toBe(true);
  });
});
