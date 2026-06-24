// T80 / T81 — V57 surface-impact sim. Pure logic (no GPU): a structure hit throws a bright spark burst OUT of
// the surface (along the normal = opposite the bullet's travel) that fades + expires, and stamps a persistent
// bullet-HOLE decal at the surface point oriented to its normal; a body hit stamps a dark WOUND at the struck
// region. Pools are hard-capped and ring-recycle; gore-intensity 0 suppresses wounds; reduce-flashes thins sparks.

import { describe, it, expect } from 'vitest';
import { ImpactSim, resolveImpactSettings, type ImpactIngestContext } from './impactView';

const settings = resolveImpactSettings('desktop-high');
const ctx: ImpactIngestContext = { goreIntensity: 1, reduceFlashes: false };

describe('ImpactSim — structure impact (T80): spark burst + bullet hole', () => {
  it('throws sparks OUT of the surface (opposite the bullet travel = along the +normal)', () => {
    const s = new ImpactSim(settings);
    // Wall facing +x (normal points back toward the shooter on the +x side); bullet travels -x into it.
    s.structureImpact(5, 1.4, 2, 1, 0, 0, ctx);
    expect(s.sparkCount).toBe(settings.sparkCount);
    // Net velocity points along the +normal (+x) — i.e. opposite the impact direction.
    let sumVx = 0;
    for (let i = 0; i < s.sparkCount; i++) sumVx += s.svx[i]!;
    expect(sumVx).toBeGreaterThan(0);
    // Every spark has a non-negative component along the normal (inside the forward cone, never into the wall).
    for (let i = 0; i < s.sparkCount; i++) expect(s.svx[i]!).toBeGreaterThanOrEqual(0);
    // Sparks originate at the surface point.
    for (let i = 0; i < s.sparkCount; i++) {
      expect(s.sx[i]).toBeCloseTo(5, 6);
      expect(s.sz[i]).toBeCloseTo(2, 6);
    }
  });

  it('spawns exactly one bullet hole at the surface point oriented to the normal', () => {
    const s = new ImpactSim(settings);
    s.structureImpact(5, 1.4, 2, 0, 0, 1, ctx); // wall facing +z
    expect(s.holeCount).toBe(1);
    expect(s.hx[0]).toBeCloseTo(5, 6);
    expect(s.hy[0]).toBeCloseTo(1.4, 6);
    expect(s.hz[0]).toBeCloseTo(2, 6);
    // Stored normal is the (normalized) surface normal the view orients the disc to.
    expect(s.hnz[0]).toBeCloseTo(1, 6);
    expect(s.woundCount).toBe(0); // a structure hit NEVER produces a wound (V57 branch)
  });

  it('sparks fade toward zero brightness and expire after their life', () => {
    const s = new ImpactSim(settings);
    s.structureImpact(0, 1, 0, 1, 0, 0, ctx);
    const startCount = s.sparkCount;
    expect(startCount).toBeGreaterThan(0);
    // Halfway through the (minimum) life, brightness has dropped below the fresh value.
    s.update(settings.sparkLifeSeconds * 0.3);
    let anyFaded = false;
    for (let i = 0; i < s.sparkCount; i++) if (s.sFade[i]! < 1) anyFaded = true;
    expect(anyFaded).toBe(true);
    // Past the maximum possible life every spark has been swap-removed.
    s.update(settings.sparkLifeSeconds * 2);
    expect(s.sparkCount).toBe(0);
  });

  it('reduce-flashes thins the spark count and dims brightness (V29)', () => {
    const full = new ImpactSim(settings);
    full.structureImpact(0, 1, 0, 1, 0, 0, ctx);
    const reduced = new ImpactSim(settings);
    reduced.structureImpact(0, 1, 0, 1, 0, 0, { goreIntensity: 1, reduceFlashes: true });
    expect(reduced.sparkCount).toBeLessThan(full.sparkCount);
    // Fresh brightness is dimmer with reduce-flashes on.
    expect(reduced.sFade[0]!).toBeLessThan(full.sFade[0]!);
  });

  it('bullet holes ring-recycle past the pool cap (V24)', () => {
    const small = new ImpactSim({ ...settings, holePoolSize: 4 });
    for (let k = 0; k < 10; k++) small.structureImpact(k, 1, 0, 1, 0, 0, ctx);
    expect(small.holeCount).toBe(4); // never exceeds the cap
  });
});

describe('ImpactSim — body wound (T81)', () => {
  it('stamps a wound at the struck region height facing the shooter', () => {
    const s = new ImpactSim(settings);
    // Body at (3,_,4), base on the ground; head shot; shooter to the -x side so the wound faces -x.
    s.wound(3, 0, 4, 'head', -1, 0, ctx);
    expect(s.woundCount).toBe(1);
    expect(s.wx[0]).toBeCloseTo(3, 6);
    expect(s.wz[0]).toBeCloseTo(4, 6);
    // Region->height map lifts the wound to the head band.
    expect(s.wy[0]).toBeCloseTo(settings.regionHeights.head, 6);
    // Faces back toward the shooter (-x), normalized.
    expect(s.wnx[0]).toBeCloseTo(-1, 6);
    // A body hit NEVER produces a wall spark or hole (V57 branch).
    expect(s.sparkCount).toBe(0);
    expect(s.holeCount).toBe(0);
  });

  it('leg vs head wounds land at different heights (region map)', () => {
    const s = new ImpactSim(settings);
    s.wound(0, 0, 0, 'legLeft', 0, 1, ctx);
    s.wound(0, 0, 0, 'head', 0, 1, ctx);
    expect(s.wy[0]).toBeCloseTo(settings.regionHeights.leg, 6);
    expect(s.wy[1]).toBeCloseTo(settings.regionHeights.head, 6);
    expect(s.wy[1]!).toBeGreaterThan(s.wy[0]!);
  });

  it('goreIntensity 0 suppresses wounds (V29)', () => {
    const s = new ImpactSim(settings);
    s.wound(0, 0, 0, 'torsoUpper', 0, 1, { goreIntensity: 0, reduceFlashes: false });
    expect(s.woundCount).toBe(0);
  });

  it('wounds ring-recycle past the pool cap, accumulating up to it (V24/T81)', () => {
    const small = new ImpactSim({ ...settings, woundPoolSize: 3 });
    expect(small.woundCount).toBe(0);
    for (let k = 0; k < 8; k++) small.wound(k, 0, 0, 'torsoUpper', 0, 1, ctx);
    expect(small.woundCount).toBe(3);
  });
});

describe('ImpactSim — glass shatter (T108): pane-break shard burst', () => {
  it('throws shards OUT of the pane along the +normal, from the window point', () => {
    const s = new ImpactSim(settings);
    s.glassShatter(5, 1.8, 2, 0, 0, 1, ctx); // pane faces +z; shards spray +z
    expect(s.shardCount).toBe(settings.shardCount);
    let sumVz = 0;
    for (let i = 0; i < s.shardCount; i++) sumVz += s.gvz[i]!;
    expect(sumVz).toBeGreaterThan(0); // net launch along the +normal
    for (let i = 0; i < s.shardCount; i++) {
      expect(s.gx[i]).toBeCloseTo(5, 6);
      expect(s.gz[i]).toBeCloseTo(2, 6);
    }
  });

  it('shards fall under gravity, tumble, then shrink-fade and expire', () => {
    const s = new ImpactSim(settings);
    s.glassShatter(0, 2, 0, 1, 0, 0, ctx);
    const ang0 = s.gAng[0]!;
    s.update(0.1);
    expect(s.gAng[0]!).not.toBe(ang0); // tumbling
    // Past max life every shard is swap-removed.
    s.update(settings.shardLifeSeconds * 2);
    expect(s.shardCount).toBe(0);
  });

  it('shard pool is hard-capped (V24) — extra bursts never grow it past the cap', () => {
    const small = new ImpactSim({ ...settings, shardPoolSize: 8, shardCount: 6 });
    for (let k = 0; k < 10; k++) small.glassShatter(k, 1.8, 0, 1, 0, 0, ctx);
    expect(small.shardCount).toBe(8);
  });

  it('reduce-flashes thins the shard burst (V29)', () => {
    const full = new ImpactSim(settings);
    full.glassShatter(0, 1.8, 0, 1, 0, 0, ctx);
    const reduced = new ImpactSim(settings);
    reduced.glassShatter(0, 1.8, 0, 1, 0, 0, { goreIntensity: 1, reduceFlashes: true });
    expect(reduced.shardCount).toBeLessThan(full.shardCount);
  });
});

describe('ImpactSim — body-anchored wounds (T81 surface-stick)', () => {
  const anchor = (x: number, z: number) => ({ x, y: 0, z, heading: 0, lying: 0, groundY: 0 });

  it('places the wound on the body surface at the struck region height, facing the shooter', () => {
    const s = new ImpactSim(settings);
    s.setBodyAnchors({ resolve: () => anchor(0, 0) });
    s.woundOnBody(7, 'head', -1, 0, ctx); // shooter on the -x side → wound on the -x surface
    expect(s.woundCount).toBe(1);
    expect(s.wx[0]!).toBeLessThan(0); // offset toward the shooter (-x)
    expect(s.wy[0]!).toBeCloseTo(settings.regionHeights.head, 5); // at the head band, not the body centre/base
    expect(Math.abs(s.wx[0]!)).toBeLessThanOrEqual(settings.woundBodyRadiusMeters + 1e-6); // hugs the surface
  });

  it('FOLLOWS the body when it moves (reprojected each frame — never floats where it was hit)', () => {
    const s = new ImpactSim(settings);
    let body = anchor(0, 0);
    s.setBodyAnchors({ resolve: () => body });
    s.woundOnBody(7, 'torsoUpper', -1, 0, ctx);
    const x0 = s.wx[0]!;
    body = anchor(10, 0); // body walks +10 m
    s.update(1 / 60);
    expect(s.wx[0]!).toBeGreaterThan(x0 + 9); // the mark tracked the body
  });

  it('no-op without a resolver or when the body is already gone', () => {
    const s = new ImpactSim(settings);
    s.woundOnBody(7, 'torsoUpper', -1, 0, ctx); // no resolver wired
    expect(s.woundCount).toBe(0);
    s.setBodyAnchors({ resolve: () => null }); // body gone
    s.woundOnBody(7, 'torsoUpper', -1, 0, ctx);
    expect(s.woundCount).toBe(0);
  });

  it('static wound() stays world-anchored (not reprojected to a body)', () => {
    const s = new ImpactSim(settings);
    s.setBodyAnchors({ resolve: () => anchor(99, 99) });
    s.wound(3, 0, 4, 'torsoUpper', 0, 1, ctx);
    s.update(1 / 60);
    expect(s.wx[0]!).toBeCloseTo(3, 5); // never snapped to the anchor at (99,99)
    expect(s.wz[0]!).toBeCloseTo(4, 5);
  });

  it('wounds persist then fade out over their lifetime', () => {
    const s = new ImpactSim(settings);
    s.wound(0, 0, 0, 'torsoUpper', 0, 1, ctx);
    expect(s.wVis[0]).toBeCloseTo(1, 6); // fresh = full visibility
    s.update(settings.woundLifeSeconds * (1 - settings.woundFadeFraction * 0.5)); // into the fade window
    expect(s.wVis[0]!).toBeLessThan(1);
    expect(s.wVis[0]!).toBeGreaterThan(0);
    s.update(settings.woundLifeSeconds); // past end of life
    expect(s.wVis[0]).toBe(0);
  });
});

describe('ImpactSim — guards', () => {
  it('rejects negative dt', () => {
    const s = new ImpactSim(settings);
    expect(() => s.update(-1)).toThrow();
  });

  it('ignores a degenerate (zero-length) surface normal', () => {
    const s = new ImpactSim(settings);
    s.structureImpact(0, 0, 0, 0, 0, 0, ctx);
    expect(s.sparkCount).toBe(0);
    expect(s.holeCount).toBe(0);
  });
});
