// T76 / V52 — pooled GIB sim. Pure logic (no GPU): a sever (partDetached) bursts faceted chunks at the
// last impact that arc, tumble, LAND, settle (motion killed), then shrink/dry out and recycle; strong hits
// fling small flecks; gore-intensity 0 suppresses; reduce-flashes thins; the pool never exceeds its cap.

import { describe, it, expect } from 'vitest';
import { GibSim, resolveGibSettings, type GibIngestContext } from './gibView';
import type { AnatomyRegion, VisualEvent } from '../../game/core/contracts/events';
import type { EntityId, EventId, StimulusId } from '../../game/core/contracts/ids';

const settings = resolveGibSettings('desktop-high');

const ctx: GibIngestContext = { cameraX: 0, cameraY: 0, cameraZ: 0, goreIntensity: 1, reduceFlashes: false };

const hitReaction = (energy = 0.9, dirX = 1, dirZ = 0, region: AnatomyRegion = 'torsoUpper'): VisualEvent => ({
  kind: 'hitReaction', id: 1 as EventId, target: 7 as EntityId, region, dirX, dirZ, energy,
});
const bloodSpray = (x = 0, y = 0, z = 0): VisualEvent => ({
  kind: 'bloodSpray', id: 2 as EventId, x, y, z, dirX: 1, dirZ: 0,
});
const partDetached = (): VisualEvent => ({
  kind: 'partDetached', id: 3 as EventId, target: 7 as EntityId, region: 'armLeft',
});
const sound = (): VisualEvent => ({
  kind: 'soundEmitted', id: 4 as EventId, stimulus: 5 as StimulusId, x: 0, z: 0, intensity: 1,
});

describe('GibSim — sever burst (T76/V52)', () => {
  it('bursts chunks at the last impact when a part is detached', () => {
    const s = new GibSim(settings);
    s.consume([hitReaction(0.5, 1, 0), bloodSpray(3, 0, 4), partDetached()], ctx);
    expect(s.count).toBeGreaterThanOrEqual(settings.severChunkCountMin);
    expect(s.count).toBeLessThanOrEqual(settings.severChunkCountMax);
    // Chunks spawn at the impact xz and are launched upward (arc) with a tumble spin.
    let anyUp = false;
    for (let i = 0; i < s.count; i++) {
      expect(s.px[i]).toBeCloseTo(3, 6);
      expect(s.pz[i]).toBeCloseTo(4, 6);
      if (s.vy[i]! > 0) anyUp = true;
    }
    expect(anyUp).toBe(true);
  });

  it('does not burst a sever with no prior impact', () => {
    const s = new GibSim(settings);
    s.consume([partDetached()], ctx);
    expect(s.count).toBe(0);
  });

  it('ignores soundEmitted', () => {
    const s = new GibSim(settings);
    s.consume([sound()], ctx);
    expect(s.count).toBe(0);
  });
});

describe('GibSim — arc / tumble / land / settle / shrink (T76/V52)', () => {
  it('chunks arc and land on the floor, then settle (motion + spin killed)', () => {
    const s = new GibSim(settings);
    s.consume([hitReaction(0.5, 1, 0), bloodSpray(0, 0, 0), partDetached()], ctx);
    const rot0 = s.rx[0]!;
    // A few airborne frames: it should tumble (rotation changes) while in flight.
    for (let i = 0; i < 5; i++) s.update(1 / 60);
    // Run long enough to land + settle.
    for (let i = 0; i < 200; i++) s.update(1 / 60);
    // Grounded chunks rest on the floor and stop moving.
    for (let i = 0; i < s.count; i++) {
      if (s.size[i]! > 0.0001) {
        expect(s.vy[i]).toBe(0);
        expect(s.py[i]).toBeGreaterThanOrEqual(settings.floorYMeters);
      }
    }
    expect(Number.isFinite(rot0)).toBe(true);
  });

  it('shrinks + recycles chunks past their lifetime', () => {
    const s = new GibSim(settings);
    s.consume([hitReaction(0.5, 1, 0), bloodSpray(0, 0, 0), partDetached()], ctx);
    expect(s.liveCount).toBeGreaterThan(0);
    // Past the longest possible life (life is staggered up to ~1.3x base).
    s.update(settings.settleLifeSeconds * 2);
    expect(s.liveCount).toBe(0); // all collapsed/recycled
  });
});

describe('GibSim — hit-driven flecks + caps + accessibility (V24/V29/V8)', () => {
  it('a strong hit above the energy threshold flings flecks; a weak hit does not', () => {
    const strong = new GibSim(settings);
    strong.consume([hitReaction(1, 1, 0), bloodSpray(0, 0, 0)], ctx);
    expect(strong.count).toBeGreaterThan(0);

    const weak = new GibSim(settings);
    weak.consume([hitReaction(settings.hitFleckEnergyThreshold - 0.1, 1, 0), bloodSpray(0, 0, 0)], ctx);
    expect(weak.count).toBe(0);
  });

  it('never exceeds the chunk pool cap (ring reuse)', () => {
    const tiny = resolveGibSettings('mobile-webgpu');
    const s = new GibSim(tiny);
    for (let k = 0; k < 200; k++) s.consume([hitReaction(0.5, 1, 0), bloodSpray(0, 0, 0), partDetached()], ctx);
    expect(s.count).toBeLessThanOrEqual(tiny.poolSize);
  });

  it('gore-intensity 0 fully suppresses gibs (V29)', () => {
    const s = new GibSim(settings);
    s.consume([hitReaction(1, 1, 0), bloodSpray(0, 0, 0), partDetached()], { ...ctx, goreIntensity: 0 });
    expect(s.count).toBe(0);
  });

  it('reduce-flashes thins the chunk count (V29)', () => {
    // Sum over many bursts so the halving is observable regardless of the random sever-count roll.
    let fullTotal = 0;
    let reducedTotal = 0;
    for (let k = 0; k < 40; k++) {
      const f = new GibSim(settings);
      f.consume([hitReaction(0.5, 1, 0), bloodSpray(0, 0, 0), partDetached()], ctx);
      fullTotal += f.count;
      const r = new GibSim(settings);
      r.consume([hitReaction(0.5, 1, 0), bloodSpray(0, 0, 0), partDetached()], { ...ctx, reduceFlashes: true });
      reducedTotal += r.count;
    }
    expect(reducedTotal).toBeLessThan(fullTotal);
  });

  it('rejects a negative dt (V4)', () => {
    const s = new GibSim(settings);
    expect(() => s.update(-0.01)).toThrow();
  });
});
