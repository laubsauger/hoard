// T35 tests — collector aggregates fed inputs into a snapshot; nullable sections; bounded markers.

import { describe, it, expect } from 'vitest';
import { DiagnosticsCollector } from './collector';

describe('DiagnosticsCollector', () => {
  it('starts with null sections (honest no-data) and empty frame summary', () => {
    const c = new DiagnosticsCollector(16, 8);
    const snap = c.snapshot();
    expect(snap.frameTime).toBeNull();
    expect(snap.render).toBeNull();
    expect(snap.zombies).toBeNull();
    expect(snap.sim).toBeNull();
    expect(snap.workerQueues).toEqual([]);
    expect(snap.markers).toEqual([]);
  });

  it('rejects a non-positive marker history size', () => {
    expect(() => new DiagnosticsCollector(16, 0)).toThrow();
  });

  it('aggregates frame timing into median/95/99 + carries last/main/gpu', () => {
    const c = new DiagnosticsCollector(64, 8);
    for (let v = 1; v <= 10; v += 1) c.recordFrame({ frameMs: v, mainThreadMs: v / 2, gpuMs: v / 3 });
    const snap = c.snapshot();
    expect(snap.frameTime!.medianMs).toBe(5);
    expect(snap.frameTime!.p95Ms).toBe(10);
    expect(snap.frameTime!.p99Ms).toBe(10);
    expect(snap.lastFrameMs).toBe(10);
    expect(snap.mainThreadMs).toBeCloseTo(5);
    expect(snap.gpuMs).toBeCloseTo(10 / 3);
    expect(c.frameSampleCount).toBe(10);
  });

  it('aggregates render + zombie + spatial sections as fed', () => {
    const c = new DiagnosticsCollector(16, 8);
    c.setRender({
      drawCalls: 120,
      triangles: 500_000,
      instances: 800,
      animGroups: 6,
      lights: 4,
      shadowCasters: 2,
      gpuMemBytesEstimate: 256 * 1024 * 1024,
      textureResidentCount: 40,
      textureResidentBytes: 64 * 1024 * 1024,
    });
    c.setZombies({
      simTierCounts: [20, 200, 800, 4000],
      renderTierCounts: [20, 200, 800, 0],
      stateCounts: { idle: 100, chase: 50 },
      updateFreqCounts: { everyTick: 220, every4: 800 },
      withTarget: 50,
    });
    c.setSpatialHash({ occupiedCells: 320, candidatePairs: 1500, maxBucketDepth: 9 });
    c.setStructural({ occupiedCells: 1200, supportLinks: 800, dirtyRegions: 3 });
    c.setNavField({ flowFields: 4, portals: 18, blockedLinks: 2, dirtyNavTiles: 5 });
    const snap = c.snapshot();
    expect(snap.render!.drawCalls).toBe(120);
    expect(snap.zombies!.simTierCounts[3]).toBe(4000);
    expect(snap.zombies!.withTarget).toBe(50);
    expect(snap.spatialHash!.candidatePairs).toBe(1500);
    expect(snap.structural!.dirtyRegions).toBe(3);
    expect(snap.navField!.dirtyNavTiles).toBe(5);
  });

  it('bounds marker history (evicts oldest beyond markerHistorySize)', () => {
    const c = new DiagnosticsCollector(16, 3);
    for (let i = 0; i < 5; i += 1) c.pushMarker({ kind: 'gc', atMs: i, durationMs: i });
    const snap = c.snapshot();
    expect(snap.markers.length).toBe(3);
    // oldest two evicted -> first retained marker is atMs=2
    expect(snap.markers[0]!.atMs).toBe(2);
    expect(snap.markers[2]!.atMs).toBe(4);
  });

  it('snapshot markers are a copy (mutating later pushes does not change a taken snapshot)', () => {
    const c = new DiagnosticsCollector(16, 8);
    c.pushMarker({ kind: 'save', atMs: 1, durationMs: 1 });
    const snap = c.snapshot();
    c.pushMarker({ kind: 'save', atMs: 2, durationMs: 1 });
    expect(snap.markers.length).toBe(1);
  });
});
