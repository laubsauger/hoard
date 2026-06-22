// T35 tests — ring-buffer percentile tracker (median/95/99), windowing, empty-window honesty.

import { describe, it, expect } from 'vitest';
import { PercentileRing } from './percentile';

describe('PercentileRing', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new PercentileRing(0)).toThrow();
    expect(() => new PercentileRing(1.5)).toThrow();
  });

  it('summary() is null and percentile() throws on an empty window (no invented value)', () => {
    const r = new PercentileRing(8);
    expect(r.summary()).toBeNull();
    expect(() => r.percentile(0.5)).toThrow();
  });

  it('computes nearest-rank median / 95th / 99th over 1..10', () => {
    const r = new PercentileRing(16);
    for (let v = 1; v <= 10; v += 1) r.push(v);
    expect(r.size).toBe(10);
    // nearest-rank: median ceil(0.5*10)=5 -> 5; p95 ceil(9.5)=10 -> 10; p99 ceil(9.9)=10 -> 10
    expect(r.percentile(0.5)).toBe(5);
    expect(r.percentile(0.95)).toBe(10);
    expect(r.percentile(0.99)).toBe(10);
    const s = r.summary()!;
    expect(s.medianMs).toBe(5);
    expect(s.p95Ms).toBe(10);
    expect(s.p99Ms).toBe(10);
    expect(s.minMs).toBe(1);
    expect(s.maxMs).toBe(10);
    expect(s.sampleCount).toBe(10);
  });

  it('is order-independent (sorts the window)', () => {
    const r = new PercentileRing(8);
    [7, 2, 9, 1, 5, 3].forEach((v) => r.push(v));
    // sorted [1,2,3,5,7,9], n=6, median ceil(0.5*6)=3 -> 3rd value = 3
    expect(r.percentile(0.5)).toBe(3);
  });

  it('evicts oldest beyond capacity (only the last `capacity` samples count)', () => {
    const r = new PercentileRing(4);
    [100, 100, 100, 100, 1, 2, 3, 4].forEach((v) => r.push(v));
    // window holds last 4 -> [1,2,3,4]
    expect(r.size).toBe(4);
    expect(r.summary()!.maxMs).toBe(4);
    expect(r.summary()!.minMs).toBe(1);
    expect(r.percentile(0.5)).toBe(2); // ceil(0.5*4)=2 -> 2nd of [1,2,3,4]
  });

  it('clamps percentile rank into [1,n] and validates p range', () => {
    const r = new PercentileRing(4);
    [1, 2, 3, 4].forEach((v) => r.push(v));
    expect(r.percentile(0)).toBe(1);
    expect(r.percentile(1)).toBe(4);
    expect(() => r.percentile(-0.1)).toThrow();
    expect(() => r.percentile(1.1)).toThrow();
  });

  it('rejects non-finite samples', () => {
    const r = new PercentileRing(4);
    expect(() => r.push(Number.NaN)).toThrow();
    expect(() => r.push(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('clear() resets the window', () => {
    const r = new PercentileRing(4);
    [1, 2, 3].forEach((v) => r.push(v));
    r.clear();
    expect(r.size).toBe(0);
    expect(r.summary()).toBeNull();
  });
});
