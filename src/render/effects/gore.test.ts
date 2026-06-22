// T19 / V8 / V29 — gore pool caps + reuse + consumes VisualEvent + gore-intensity gating + disposal.

import { describe, it, expect } from 'vitest';
import { GoreSystem, GoreRenderer, resolveGoreSettings, type GoreSettings } from './gore';
import { ResourceRegistry } from '../engine/resources';
import type { VisualEvent } from '../../game/core/contracts/events';
import type { EntityId, EventId, StimulusId } from '../../game/core/contracts/ids';

const hitReaction = (dirX = 1, dirZ = 0, energy = 0.8): VisualEvent => ({
  kind: 'hitReaction', id: 1 as EventId, target: 7 as EntityId, region: 'torsoUpper', dirX, dirZ, energy,
});
const bloodSpray = (): VisualEvent => ({
  kind: 'bloodSpray', id: 2 as EventId, x: 1, y: 0, z: 2, dirX: 0, dirZ: 1,
});
const partDetached = (): VisualEvent => ({
  kind: 'partDetached', id: 3 as EventId, target: 7 as EntityId, region: 'armLeft',
});
const sound = (): VisualEvent => ({
  kind: 'soundEmitted', id: 4 as EventId, stimulus: 5 as StimulusId, x: 0, z: 0, intensity: 1,
});

const tinyPools: GoreSettings = {
  sprayPoolSize: 3,
  stainPoolSize: 2,
  severPoolSize: 2,
  sprayParticlesPerEvent: 10,
  distantSimplifyMeters: 20,
};

describe('GoreSystem (T19)', () => {
  it('consumes only gore VisualEvents; ignores soundEmitted', () => {
    const g = new GoreSystem(tinyPools);
    expect(g.ingest(hitReaction(), 1, 1)).not.toBeNull();
    expect(g.ingest(bloodSpray(), 1, 1)).not.toBeNull();
    expect(g.ingest(partDetached(), 1, 1)).not.toBeNull();
    expect(g.ingest(sound(), 1, 1)).toBeNull();
  });

  it('never exceeds the pool capacity and recycles the oldest record when full (V8 cap + reuse)', () => {
    const g = new GoreSystem(tinyPools);
    const first = g.ingest(hitReaction(), 1, 1)!;
    g.ingest(hitReaction(), 1, 1);
    g.ingest(hitReaction(), 1, 1);
    expect(g.activeCount('spray')).toBe(tinyPools.sprayPoolSize); // full
    const firstSeq = first.seq;

    // Fourth spray must recycle the oldest record (first), not grow the pool.
    const recycled = g.ingest(hitReaction(), 1, 1)!;
    expect(g.activeCount('spray')).toBe(tinyPools.sprayPoolSize); // still capped
    expect(recycled).toBe(first); // same object reused
    expect(recycled.seq).toBeGreaterThan(firstSeq); // re-stamped
  });

  it('routes events to distinct pools (spray / stain-no, sever)', () => {
    const g = new GoreSystem(tinyPools);
    g.ingest(partDetached(), 1, 1);
    expect(g.activeCount('sever')).toBe(1);
    expect(g.activeCount('spray')).toBe(0);
  });

  it('gates entirely on gore-intensity 0 (V29 accessibility)', () => {
    const g = new GoreSystem(tinyPools);
    expect(g.ingest(hitReaction(), 1, 0)).toBeNull();
    expect(g.activeCount('spray')).toBe(0);
  });

  it('scales near particle count by intensity but simplifies distant gore to one puff', () => {
    const g = new GoreSystem(tinyPools);
    const near = g.ingest(hitReaction(), 1, 1)!;
    expect(near.particles).toBe(tinyPools.sprayParticlesPerEvent);
    const half = g.ingest(hitReaction(), 1, 0.5)!;
    expect(half.particles).toBe(Math.round(tinyPools.sprayParticlesPerEvent * 0.5));
    const distant = g.ingest(hitReaction(), tinyPools.distantSimplifyMeters + 5, 1)!;
    expect(distant.particles).toBe(1);
  });

  it('carries impact direction + energy through (directional spray)', () => {
    const g = new GoreSystem(tinyPools);
    const rec = g.ingest(hitReaction(0, -1, 1), 1, 1)!;
    expect(rec.dirX).toBe(0);
    expect(rec.dirZ).toBe(-1);
    expect(rec.energy).toBe(1);
  });

  it('rejects invalid intensity / distance (V4)', () => {
    const g = new GoreSystem(tinyPools);
    expect(() => g.ingest(hitReaction(), 1, 1.5)).toThrow();
    expect(() => g.ingest(hitReaction(), -1, 1)).toThrow();
  });

  it('release() frees a slot back to the pool', () => {
    const g = new GoreSystem(tinyPools);
    const rec = g.ingest(hitReaction(), 1, 1)!;
    expect(g.activeCount('spray')).toBe(1);
    g.release(rec);
    expect(g.activeCount('spray')).toBe(0);
  });
});

describe('GoreRenderer (V24 disposal)', () => {
  it('tracks its instanced batches + geometry + material for disposal', () => {
    const registry = new ResourceRegistry();
    const settings = resolveGoreSettings('desktop-high');
    const renderer = new GoreRenderer(settings, registry);
    expect(renderer.sprayBatch.count).toBe(0);
    expect(registry.size).toBe(4); // geometry + material + spray batch + stain batch
    registry.disposeAll();
    expect(() => registry.assertNoLeaks()).not.toThrow();
  });
});
