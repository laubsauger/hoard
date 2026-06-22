// T35 tests — debug config domain registers + resolves; runtime wires collector->store with a
// throttled publisher; flag sync reaches the store. Importing debug.ts self-registers the domain
// (vitest isolates this file, so registration happens exactly once here).

import { describe, it, expect } from 'vitest';
import { resolveDomain, registeredDomains } from '../config/registry';
import { debugConfig } from '../config/domains/debug';
import { createDiagnostics } from './setup';

describe('debug config domain (V4)', () => {
  it('self-registers the debug domain on import', () => {
    expect(registeredDomains()).toContain('debug');
  });

  it('resolves typed values per tier (overlay default off on mobile, smaller percentile window)', () => {
    const high = resolveDomain(debugConfig, 'desktop-high');
    const mobile = resolveDomain(debugConfig, 'mobile-webgpu');
    expect(high.overlayEnabledByDefault).toBe(true);
    expect(mobile.overlayEnabledByDefault).toBe(false);
    expect(high.percentileWindowSize).toBe(240);
    expect(mobile.percentileWindowSize).toBe(60);
    expect(high.refreshThrottleMs).toBeGreaterThanOrEqual(50);
  });
});

describe('createDiagnostics runtime', () => {
  it('sets overlay visibility from the per-tier default', () => {
    const onMobile = createDiagnostics('mobile-webgpu');
    expect(onMobile.store.getState().overlayVisible).toBe(false);
    const onDesktop = createDiagnostics('desktop-high');
    expect(onDesktop.store.getState().overlayVisible).toBe(true);
  });

  it('publishes collector snapshots to the store, throttled to refreshThrottleMs', () => {
    let clock = 0;
    const now = () => clock;
    const rt = createDiagnostics('desktop-high', now);
    const interval = resolveDomain(debugConfig, 'desktop-high').refreshThrottleMs;

    rt.collector.recordFrame({ frameMs: 8, mainThreadMs: 4, gpuMs: 3 });
    rt.publish(); // leading edge fires immediately
    expect(rt.store.getState().snapshot.lastFrameMs).toBe(8);

    // within the interval -> coalesced, store not updated
    rt.collector.recordFrame({ frameMs: 20, mainThreadMs: 4, gpuMs: 3 });
    rt.publish();
    expect(rt.store.getState().snapshot.lastFrameMs).toBe(8);

    // advance past the interval -> next publish delivers
    clock += interval;
    rt.collector.recordFrame({ frameMs: 12, mainThreadMs: 4, gpuMs: 3 });
    rt.publish();
    expect(rt.store.getState().snapshot.lastFrameMs).toBe(12);
  });

  it('flush() delivers a coalesced snapshot', () => {
    const clock = 0;
    const rt = createDiagnostics('desktop-high', () => clock);
    rt.collector.recordFrame({ frameMs: 8, mainThreadMs: 4, gpuMs: 3 });
    rt.publish();
    rt.collector.recordFrame({ frameMs: 99, mainThreadMs: 4, gpuMs: 3 });
    rt.publish(); // coalesced
    rt.flush();
    expect(rt.store.getState().snapshot.lastFrameMs).toBe(99);
  });

  it('syncFlags() pushes flag state into the store', () => {
    const rt = createDiagnostics('desktop-high');
    rt.flags.toggle('freezeTiers');
    rt.syncFlags();
    expect(rt.store.getState().flags.freezeTiers).toBe(true);
  });
});
