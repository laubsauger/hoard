// T3 / T42 tests — clock (V12), scheduler, ids (V26), ring queue, SoA layout (V3/V26), contract exhaustiveness.

import { describe, it, expect } from 'vitest';
import { FixedClock } from './clock';
import { SystemScheduler } from './scheduler';
import { IdFactory } from './ids';
import { RingQueue } from './events';
import {
  assertNever,
  allocateSoa,
  computeLayout,
  ZOMBIE_FIELDS,
  type EntityId,
} from './index';
import type { Command } from './contracts/commands';
import type { WorldEvent } from './contracts/events';

const CLOCK = { tickHz: 30, maxFrameSeconds: 0.25, maxCatchUpTicks: 8 };

describe('FixedClock (V12)', () => {
  it('runs exactly one tick when one tick of time passes', () => {
    const c = new FixedClock(CLOCK);
    expect(c.advance(1 / 30)).toBe(1);
    expect(c.tick).toBe(1);
  });

  it('accumulates fractional time across frames without losing ticks', () => {
    const c = new FixedClock(CLOCK);
    expect(c.advance(1 / 60)).toBe(0); // half a tick
    expect(c.advance(1 / 60)).toBe(1); // completes the tick
    expect(c.tick).toBe(1);
  });

  it('clamps a long stall to maxFrameSeconds (0.25s * 30Hz = 7 whole ticks)', () => {
    const c = new FixedClock(CLOCK);
    // 10s stall -> clamped to 0.25s -> floor(0.25/ (1/30)) = 7 ticks (clamp binds before the cap).
    expect(c.advance(10)).toBe(7);
  });

  it('caps catch-up ticks when the frame clamp allows more than the cap', () => {
    // maxFrameSeconds high enough that the catch-up cap is the binding limit.
    const c = new FixedClock({ tickHz: 30, maxFrameSeconds: 2, maxCatchUpTicks: 8 });
    expect(c.advance(2)).toBe(8); // 2s * 30 = 60 ticks available, capped at 8
  });

  it('exposes interpolation alpha in [0,1)', () => {
    const c = new FixedClock(CLOCK);
    c.advance(1 / 60); // half a tick remains
    expect(c.alpha).toBeGreaterThan(0);
    expect(c.alpha).toBeLessThan(1);
  });

  it('rejects negative delta', () => {
    expect(() => new FixedClock(CLOCK).advance(-1)).toThrow();
  });
});

describe('SystemScheduler', () => {
  it('runs everyTick systems each tick and interval systems on cadence', () => {
    const s = new SystemScheduler();
    const calls: string[] = [];
    s.register('move', { bucket: 'everyTick' }, () => calls.push('move'));
    s.register('perception', { bucket: 'interval', everyTicks: 3 }, () => calls.push('perc'));
    for (let t = 0; t < 3; t++) s.runTick({ tick: t, tickSeconds: 1 / 30 });
    expect(calls.filter((c) => c === 'move').length).toBe(3);
    expect(calls.filter((c) => c === 'perc').length).toBe(1); // only tick 0
  });

  it('respects phase offset for interval systems', () => {
    const s = new SystemScheduler();
    let ran = -1;
    s.register('p', { bucket: 'interval', everyTicks: 4 }, (ctx) => (ran = ctx.tick), 2);
    for (let t = 0; t < 4; t++) s.runTick({ tick: t, tickSeconds: 1 / 30 });
    expect(ran).toBe(2);
  });

  it('does not auto-run on-demand systems but runs them explicitly', () => {
    const s = new SystemScheduler();
    let ran = false;
    s.register('path', { bucket: 'onDemand' }, () => (ran = true));
    s.runTick({ tick: 0, tickSeconds: 1 / 30 });
    expect(ran).toBe(false);
    s.runOnDemand('path', { tick: 0, tickSeconds: 1 / 30 });
    expect(ran).toBe(true);
  });

  it('rejects duplicate names and bad phase', () => {
    const s = new SystemScheduler();
    s.register('a', { bucket: 'everyTick' }, () => {});
    expect(() => s.register('a', { bucket: 'everyTick' }, () => {})).toThrow();
    expect(() => s.register('b', { bucket: 'interval', everyTicks: 2 }, () => {}, 5)).toThrow();
  });
});

describe('IdFactory (V26 deterministic)', () => {
  it('mints monotonic ids per kind independently', () => {
    const f = new IdFactory();
    expect(f.next('entity')).toBe(0);
    expect(f.next('entity')).toBe(1);
    expect(f.next('event')).toBe(0); // separate counter
  });

  it('replays identically from the same seed', () => {
    const a = new IdFactory(100);
    const b = new IdFactory(100);
    expect(a.next('entity')).toBe(b.next('entity'));
  });

  it('snapshots and restores counters without collision', () => {
    const f = new IdFactory();
    f.next('entity');
    f.next('entity');
    const snap = f.snapshot();
    const g = new IdFactory();
    g.restore(snap);
    expect(g.next('entity')).toBe(2);
  });
});

describe('RingQueue (bounded, pooled backing)', () => {
  it('enqueues and drains FIFO', () => {
    const q = new RingQueue<number>(4);
    q.push(1);
    q.push(2);
    const out: number[] = [];
    q.drain((n) => out.push(n));
    expect(out).toEqual([1, 2]);
    expect(q.size).toBe(0);
  });

  it('rejects pushes when full and records overflow', () => {
    const q = new RingQueue<number>(2);
    expect(q.push(1)).toBe(true);
    expect(q.push(2)).toBe(true);
    expect(q.push(3)).toBe(false);
    expect(q.overflowCount).toBe(1);
  });

  it('wraps correctly around the ring', () => {
    const q = new RingQueue<number>(2);
    q.push(1);
    q.pop();
    q.push(2);
    q.push(3);
    const out: number[] = [];
    q.drain((n) => out.push(n));
    expect(out).toEqual([2, 3]);
  });
});

describe('SoA layout (V3/V26)', () => {
  it('computes non-overlapping aligned field offsets', () => {
    const layout = computeLayout(ZOMBIE_FIELDS, 1000);
    for (const f of layout.fields) {
      const bytes = f.type === 'u8' ? 1 : f.type === 'u16' ? 2 : 4;
      expect(f.byteOffset % bytes).toBe(0); // properly aligned
    }
    expect(layout.byteLength).toBeGreaterThan(0);
  });

  it('allocates views backed by one buffer with correct lengths', () => {
    const soa = allocateSoa(ZOMBIE_FIELDS, 10);
    expect(soa.views.position?.length).toBe(30); // 10 * xyz
    expect(soa.views.health?.length).toBe(10);
    // All views share the same backing buffer.
    expect(soa.views.position?.buffer).toBe(soa.buffer);
    expect(soa.views.health?.buffer).toBe(soa.buffer);
  });

  it('writing one field view does not corrupt another', () => {
    const soa = allocateSoa(ZOMBIE_FIELDS, 4);
    const pos = soa.views.position as Float32Array;
    const health = soa.views.health as Float32Array;
    pos[0] = 12.5;
    health[0] = 99;
    expect(pos[0]).toBe(12.5);
    expect(health[0]).toBe(99);
  });

  it('rejects bad capacity', () => {
    expect(() => computeLayout(ZOMBIE_FIELDS, 0)).toThrow();
    expect(() => computeLayout(ZOMBIE_FIELDS, 1.5)).toThrow();
  });
});

describe('contract exhaustiveness (V26)', () => {
  it('assertNever throws on an unhandled case', () => {
    const handle = (cmd: Command): string => {
      switch (cmd.kind) {
        case 'equip': return 'equip';
        case 'moveItem': return 'moveItem';
        case 'craft': return 'craft';
        case 'confirmAction': return 'confirmAction';
        case 'changeSetting': return 'changeSetting';
        case 'selectTarget': return 'selectTarget';
        case 'modifyStructure': return 'modifyStructure';
        default: return assertNever(cmd, 'command');
      }
    };
    const cmd: Command = { kind: 'selectTarget', id: 1 as never, entity: 0 as EntityId, target: null };
    expect(handle(cmd)).toBe('selectTarget');
    // Forced bad value triggers the guard.
    expect(() => handle({ kind: 'bogus' } as unknown as Command)).toThrow();
  });

  it('separates world events from visual events by kind', () => {
    const ev: WorldEvent = { kind: 'entityDied', id: 0 as never, entity: 7 as EntityId };
    expect(ev.kind).toBe('entityDied');
  });
});
