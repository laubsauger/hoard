// FIRE visuals — pure FireField logic (no GPU). Covers the invariants the GPU FireView relies on:
//   - a flame entry is created per burning cell and removed when the cell stops burning,
//   - the entry pool is hard-capped at maxCells (V24),
//   - the flicker clock advances on update + intensity ramps in (catch-in),
//   - burn intensity scales flame size + brightness,
//   - the light pool caps to the N strongest fires (V8/V22),
//   - distance-simplify reduces the per-fire quad count and culls past the cull radius (V8).

import { describe, it, expect } from 'vitest';
import { FireField, resolveFireSettings, type FireSettings, type FireIgnition } from './fireView';

const base = resolveFireSettings('desktop-high');

function ig(cell: number, x = cell * 10, z = 0): FireIgnition {
  return { cell, x, y: 0, z };
}

describe('FireField — burning-cell set drives flame entries', () => {
  it('creates one flame entry per burning cell', () => {
    const f = new FireField(base);
    expect(f.count).toBe(0);
    f.ingest([ig(1), ig(2), ig(3)]);
    expect(f.count).toBe(3);
  });

  it('is idempotent per cell — a re-reported ignition refreshes position, not the count', () => {
    const f = new FireField(base);
    f.ingest([ig(1, 5, 5)]);
    f.ingest([ig(1, 9, 9)]);
    expect(f.count).toBe(1);
  });

  it('removes a flame entry when its cell stops burning', () => {
    const f = new FireField(base);
    f.ingest([ig(1), ig(2)]);
    f.retain((cell) => cell === 1); // cell 2 stopped burning
    expect(f.count).toBe(1);
    f.retain(() => false); // all out
    expect(f.count).toBe(0);
  });

  it('hard-caps the entry pool at maxCells (V24)', () => {
    const small: FireSettings = { ...base, maxCells: 4 };
    const f = new FireField(small);
    f.ingest(Array.from({ length: 20 }, (_, i) => ig(i)));
    expect(f.count).toBe(4);
  });
});

describe('FireField — flicker clock + intensity ramp', () => {
  it('advances the flicker clock on update', () => {
    const f = new FireField(base);
    f.ingest([ig(1)]);
    const t0 = f.time;
    f.update(0.5);
    expect(f.time).toBeGreaterThan(t0);
    f.update(0.5);
    expect(f.time).toBeGreaterThan(0.9);
  });

  it('flicker is a finite wobble around 1 within the flicker amplitude', () => {
    const f = new FireField(base);
    f.update(0.123);
    const v = f.flameFlicker(0);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(1 - base.flickerAmount - 1e-6);
    expect(v).toBeLessThanOrEqual(1 + base.flickerAmount + 1e-6);
  });

  it('reduce-flashes damps the flicker amplitude (V29)', () => {
    // Pick a clock where sin() is near its peak so the damped wobble is provably smaller.
    const f = new FireField(base);
    const peakT = 1 / (4 * base.flickerHz); // sin(2π·hz·t) = sin(π/2) = 1
    f.update(peakT);
    const full = Math.abs(f.flameFlicker(0) - 1);
    f.setReduceFlashes(true);
    const damped = Math.abs(f.flameFlicker(0) - 1);
    expect(damped).toBeLessThan(full);
  });
});

describe('FireField — intensity scales size + brightness', () => {
  it('a stronger fire yields a larger flame quad', () => {
    const f = new FireField(base);
    expect(f.flameSize(1, 1, 1)).toBeGreaterThan(f.flameSize(0.2, 1, 1));
  });

  it('a stronger fire yields a brighter flame', () => {
    const f = new FireField(base);
    expect(f.flameBrightness(1, 1)).toBeGreaterThan(f.flameBrightness(0.2, 1));
  });

  it('intensity ramps up after ignition (catch-in)', () => {
    const f = new FireField(base);
    f.ingest([ig(1)]);
    const before = f.entries()[0]!.intensity;
    f.update(2); // long enough to reach full at growthPerSec
    const after = f.entries()[0]!.intensity;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(1);
  });
});

describe('FireField — light pool caps to the N strongest (V8/V22)', () => {
  it('returns at most lightCount picks, strongest first', () => {
    const cfg: FireSettings = { ...base, lightCount: 2, growthPerSec: 1000 };
    const f = new FireField(cfg);
    // Stagger ignition + ramp so the three fires have distinctly different intensities.
    f.ingest([ig(1)]);
    f.update(1); // cell 1 → full (1.0)
    f.ingest([ig(2)]);
    f.update(0.0005); // cell 2 → a small step above spawn
    f.ingest([ig(3)]); // cell 3 → spawn intensity (lowest)
    const picks = f.selectLights(0, 0);
    expect(picks.length).toBe(2);
    expect(picks[0]!.intensity).toBeGreaterThanOrEqual(picks[1]!.intensity);
    // The strongest (cell 1, at x=10) must be selected; the weakest (cell 3) must be dropped.
    expect(picks[0]!.x).toBe(10);
  });

  it('lifts the light to the configured height and excludes fires past the cull radius', () => {
    const f = new FireField(base);
    f.ingest([ig(1, 0, 0)]);
    f.update(0.1);
    const near = f.selectLights(0, 0);
    expect(near.length).toBe(1);
    expect(near[0]!.y).toBeCloseTo(base.lightHeightMeters, 5);
    // Camera far beyond the cull radius → no light.
    const far = f.selectLights(base.cullDistanceMeters + 50, 0);
    expect(far.length).toBe(0);
  });
});

describe('FireField — distance-simplify reduces quad count (V8)', () => {
  it('draws fewer quads far away than near', () => {
    const f = new FireField(base);
    const near = f.quadCountFor(1, base.simplifyStartMeters - 1);
    const far = f.quadCountFor(1, base.simplifyEndMeters + 5);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThanOrEqual(1); // never below a single quad until culled
  });

  it('uses the full quad count within the simplify-start radius', () => {
    const f = new FireField(base);
    expect(f.quadCountFor(1, 0)).toBe(base.quadsPerCell);
  });

  it('culls (zero quads) past the cull radius', () => {
    const f = new FireField(base);
    expect(f.quadCountFor(1, base.cullDistanceMeters + 1)).toBe(0);
  });

  it('a fainter fire uses fewer quads than a full one at the same distance', () => {
    const f = new FireField(base);
    const strong = f.quadCountFor(1, 0);
    const weak = f.quadCountFor(0.2, 0);
    expect(weak).toBeLessThanOrEqual(strong);
    expect(weak).toBeGreaterThanOrEqual(1);
  });
});
