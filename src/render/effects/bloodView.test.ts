// T75 / V51 — pooled BLOOD sim. Pure logic (no GPU): droplets spawn along the hit vector at the struck
// region height, arc under gravity, LAND as drying directional decals; decals dry toward the floor colour
// and recycle past the cap; gore-intensity 0 suppresses; reduce-flashes thins; pools never exceed caps.

import { describe, it, expect } from 'vitest';
import { BloodSim, resolveBloodSettings, dropletStreakDims, type BloodIngestContext, type SurfaceHit, type SurfaceProjector, type BodyAnchor } from './bloodView';
import type { AnatomyRegion, VisualEvent } from '../../game/core/contracts/events';
import type { EntityId, EventId, StimulusId } from '../../game/core/contracts/ids';

const settings = resolveBloodSettings('desktop-high');

const ctx: BloodIngestContext = {
  cameraX: 0, cameraY: 0, cameraZ: 0, goreIntensity: 1, reduceFlashes: false, playerX: 1000, playerZ: 1000,
};

const hitReaction = (energy = 0.8, dirX = 1, dirZ = 0, region: AnatomyRegion = 'torsoUpper'): VisualEvent => ({
  kind: 'hitReaction', id: 1 as EventId, target: 7 as EntityId, region, dirX, dirZ, energy,
});
const bloodSpray = (x = 2, y = 0, z = 3): VisualEvent => ({
  kind: 'bloodSpray', id: 2 as EventId, x, y, z, dirX: 1, dirZ: 0,
});
const partDetached = (): VisualEvent => ({
  kind: 'partDetached', id: 3 as EventId, target: 7 as EntityId, region: 'armLeft',
});
const sound = (): VisualEvent => ({
  kind: 'soundEmitted', id: 4 as EventId, stimulus: 5 as StimulusId, x: 0, z: 0, intensity: 1,
});

describe('BloodSim — directional droplet spawn (T75/V51)', () => {
  it('spawns N droplets at the struck region height with velocity along the hit vector', () => {
    const s = new BloodSim(settings);
    s.consume([hitReaction(1, 1, 0, 'head'), bloodSpray(2, 0, 3)], ctx);
    expect(s.dropletCount).toBeGreaterThan(1);
    // Spawned at the head-band height above the impact base (V48 region map).
    for (let i = 0; i < s.dropletCount; i++) {
      expect(s.py[i]).toBeCloseTo(settings.regionHeights.head, 6);
    }
    // Net horizontal momentum points along +x (the hit direction).
    let sumVx = 0;
    for (let i = 0; i < s.dropletCount; i++) sumVx += s.vx[i]!;
    expect(sumVx).toBeGreaterThan(0);
    // All launched upward (arc) before gravity.
    for (let i = 0; i < s.dropletCount; i++) expect(s.vy[i]).toBeGreaterThan(0);
  });

  it('scales droplet volume with hit energy', () => {
    const lo = new BloodSim(settings);
    lo.consume([hitReaction(0.1), bloodSpray()], ctx);
    const hi = new BloodSim(settings);
    hi.consume([hitReaction(1), bloodSpray()], ctx);
    expect(hi.dropletCount).toBeGreaterThan(lo.dropletCount);
  });

  it('ignores soundEmitted (not gore)', () => {
    const s = new BloodSim(settings);
    s.consume([sound()], ctx);
    expect(s.dropletCount).toBe(0);
  });
});

describe('BloodSim — arc + land -> directional decal (T75/V51)', () => {
  it('droplets arc under gravity and land, spawning floor decals', () => {
    const s = new BloodSim(settings);
    s.consume([hitReaction(1, 1, 0), bloodSpray(0, 0, 0)], ctx);
    const spawned = s.dropletCount;
    expect(spawned).toBeGreaterThan(0);
    // Advance well past the time it takes the arc to fall to the floor.
    for (let i = 0; i < 120; i++) s.update(1 / 60);
    expect(s.dropletCount).toBe(0); // all landed/recycled
    expect(s.decalCount).toBeGreaterThan(0); // some left directional floor decals
  });

  it('decals dry toward the floor shadow colour over their lifetime', () => {
    const s = new BloodSim(settings);
    s.consume([hitReaction(1, 1, 0), bloodSpray(0, 0, 0)], ctx);
    for (let i = 0; i < 90; i++) s.update(1 / 60); // land
    expect(s.decalCount).toBeGreaterThan(0);
    const freshR = s.cr[0]!;
    const distFresh = Math.abs(freshR - s.dryTarget.r);
    s.update(settings.decalLifeSeconds * 0.95); // near end of life
    const distDry = Math.abs(s.cr[0]! - s.dryTarget.r);
    expect(distDry).toBeLessThan(distFresh); // moved toward the dry target
  });

  it('throws extra blood at the last impact when a part is detached', () => {
    const s = new BloodSim(settings);
    s.consume([hitReaction(1, 1, 0), bloodSpray(5, 0, 5)], ctx);
    const afterHit = s.dropletCount;
    s.consume([partDetached()], ctx);
    expect(s.dropletCount).toBeGreaterThan(afterHit);
  });
});

describe('BloodSim — caps + accessibility (V24/V29/V8)', () => {
  it('never exceeds the droplet pool cap (ring/swap reuse)', () => {
    const tiny = resolveBloodSettings('mobile-webgpu');
    const s = new BloodSim(tiny);
    for (let k = 0; k < 200; k++) s.consume([hitReaction(1, 1, 0), bloodSpray(0, 0, 0)], ctx);
    expect(s.dropletCount).toBeLessThanOrEqual(tiny.dropletPoolSize);
  });

  it('never exceeds the decal pool cap', () => {
    const tiny = resolveBloodSettings('mobile-webgpu');
    const s = new BloodSim(tiny);
    for (let k = 0; k < 300; k++) {
      s.consume([hitReaction(1, 1, 0), bloodSpray(0, 0, 0)], ctx);
      for (let i = 0; i < 60; i++) s.update(1 / 60);
    }
    expect(s.decalCount).toBeLessThanOrEqual(tiny.decalPoolSize);
  });

  it('gore-intensity 0 fully suppresses blood (V29)', () => {
    const s = new BloodSim(settings);
    s.consume([hitReaction(1, 1, 0), bloodSpray(), partDetached()], { ...ctx, goreIntensity: 0 });
    expect(s.dropletCount).toBe(0);
  });

  it('reduce-flashes thins the droplet count (V29)', () => {
    const normal = new BloodSim(settings);
    normal.consume([hitReaction(1, 1, 0), bloodSpray()], ctx);
    const reduced = new BloodSim(settings);
    reduced.consume([hitReaction(1, 1, 0), bloodSpray()], { ...ctx, reduceFlashes: true });
    expect(reduced.dropletCount).toBeLessThan(normal.dropletCount);
  });

  it('distant hits are simplified to fewer droplets (V8)', () => {
    const near = new BloodSim(settings);
    near.consume([hitReaction(1, 1, 0), bloodSpray(0, 0, 0)], ctx);
    const farZ = settings.distantSimplifyMeters + 20;
    const far = new BloodSim(settings);
    far.consume([hitReaction(1, 1, 0), bloodSpray(0, 0, farZ)], ctx);
    expect(far.dropletCount).toBeLessThan(near.dropletCount);
  });

  it('rejects a negative dt (V4)', () => {
    const s = new BloodSim(settings);
    expect(() => s.update(-0.1)).toThrow();
  });
});

describe('BloodSim — organic directional decals (T77/V54)', () => {
  it('floor decals elongate ALONG the impact velocity (length > width)', () => {
    const s = new BloodSim(settings);
    for (let k = 0; k < 4; k++) s.consume([hitReaction(1, 1, 0), bloodSpray(k, 0, 0)], ctx);
    for (let i = 0; i < 120; i++) s.update(1 / 60);
    expect(s.decalCount).toBeGreaterThan(0);
    for (let i = 0; i < s.decalCount; i++) {
      expect(s.cLen[i]!).toBeGreaterThan(s.cWid[i]!); // a streak, never a uniform disc
    }
  });

  it('decal length axis rotates TOWARD the travel direction', () => {
    const meanCos = (dirX: number, dirZ: number): number => {
      const sim = new BloodSim(settings);
      for (let k = 0; k < 8; k++) sim.consume([hitReaction(1, dirX, dirZ), bloodSpray(k, 0, 0)], ctx);
      for (let i = 0; i < 120; i++) sim.update(1 / 60);
      let sum = 0;
      for (let i = 0; i < sim.decalCount; i++) sum += Math.cos(sim.cRot[i]!);
      return sim.decalCount > 0 ? sum / sim.decalCount : 0;
    };
    // +x travel → length axis points ≈+x (cos≈+1); −x travel → ≈−x (cos≈−1).
    expect(meanCos(1, 0)).toBeGreaterThan(0.3);
    expect(meanCos(-1, 0)).toBeLessThan(-0.3);
  });

  it('keeps droplet counts modest but every visible hit GUARANTEES a floor splat (T79 juice)', () => {
    const weak = new BloodSim(settings);
    weak.consume([hitReaction(0.15, 1, 0), bloodSpray(0, 0, 0)], ctx);
    expect(weak.dropletCount).toBeLessThanOrEqual(settings.dropletsPerHit); // droplet jet stays skewed low
    // A single hit drops at least one floor splat the instant it sprays (blood never falls THROUGH the floor).
    const one = new BloodSim(settings);
    one.consume([hitReaction(1, 1, 0), bloodSpray(0, 0, 0)], ctx);
    expect(one.decalCount).toBeGreaterThanOrEqual(1);
    // Many hits → at least one stain each, but pooled/capped (never unbounded).
    const s = new BloodSim(settings);
    for (let k = 0; k < 12; k++) s.consume([hitReaction(1, 1, 0), bloodSpray(k * 0.3, 0, 0)], ctx);
    expect(s.decalCount).toBeGreaterThanOrEqual(12); // guaranteed stain per hit
    expect(s.decalCount).toBeLessThanOrEqual(settings.decalPoolSize); // still capped (V24)
  });

  it('holds fresh briefly, DRIES to the dried-blood colour, then LINGERS dried (slow decay)', () => {
    const s = new BloodSim(settings);
    for (let k = 0; k < 6; k++) s.consume([hitReaction(1, 1, 0), bloodSpray(k * 0.2, 0, 0)], ctx);
    for (let i = 0; i < 90; i++) s.update(1 / 60); // land
    expect(s.decalCount).toBeGreaterThan(0);
    const freshR = s.cr[0]!;
    // After the fresh hold + dry transition the decal sits AT the dried colour.
    s.update(settings.decalFreshSeconds + settings.decalDryTransitionSeconds);
    const driedR = s.cr[0]!;
    expect(Math.abs(driedR - s.dryTarget.r)).toBeLessThan(0.02);
    expect(driedR).toBeLessThan(freshR); // darkened from fresh
    // It then LINGERS dried for a long time (well before the end-of-life fade) — not gone.
    s.update(settings.decalLifeSeconds * 0.4);
    expect(Math.abs(s.cr[0]! - s.dryTarget.r)).toBeLessThan(0.05);
  });
});

describe('BloodSim — surface projection (T77/V54)', () => {
  // Mock projector: interior floor slab at y=0.2 (normal up) + a wall the spray ray strikes (normal −x).
  const FLOOR: SurfaceHit = { x: 0, y: 0.2, z: 0, nx: 0, ny: 1, nz: 0 };
  const WALL: SurfaceHit = { x: 2.5, y: 1.1, z: 0, nx: -1, ny: 0, nz: 0 };
  class MockProjector implements SurfaceProjector {
    floorCalls = 0;
    wallCalls = 0;
    floorBelow(x: number, _fromY: number, z: number): SurfaceHit | null {
      this.floorCalls++;
      return { ...FLOOR, x, z };
    }
    wallAlong(): SurfaceHit | null {
      this.wallCalls++;
      return WALL;
    }
  }

  it('lands floor decals at the PROJECTED slab height + up normal (indoors fix)', () => {
    const s = new BloodSim(settings);
    const proj = new MockProjector();
    s.setProjector(proj);
    for (let k = 0; k < 4; k++) s.consume([hitReaction(1, 1, 0, 'torsoUpper'), bloodSpray(k, 0, 0)], ctx);
    for (let i = 0; i < 120; i++) s.update(1 / 60);
    expect(proj.floorCalls).toBeGreaterThan(0);
    // Some decal lands ON the slab (y≈0.2), oriented flat (normal up) — not at the default flat floor 0.04.
    let floorDecals = 0;
    for (let i = 0; i < s.decalCount; i++) {
      if (s.cny[i]! > 0.5) {
        expect(s.cy[i]!).toBeCloseTo(0.2, 5);
        floorDecals++;
      }
    }
    expect(floorDecals).toBeGreaterThan(0);
  });

  it('stamps VERTICAL wall splats at the wall hit, oriented to the wall normal', () => {
    const s = new BloodSim(settings);
    const proj = new MockProjector();
    s.setProjector(proj);
    s.consume([hitReaction(1, 1, 0, 'torsoUpper'), bloodSpray(0, 0, 0)], ctx);
    expect(proj.wallCalls).toBe(1);
    let wallDecals = 0;
    for (let i = 0; i < s.decalCount; i++) {
      if (Math.abs(s.cny[i]!) < 0.5) {
        // placed at the wall hit point, normal horizontal (−x).
        expect(s.cx[i]!).toBeCloseTo(WALL.x, 1);
        expect(s.cnx[i]!).toBeCloseTo(-1, 5);
        expect(s.cny[i]!).toBeCloseTo(0, 5);
        wallDecals++;
      }
    }
    expect(wallDecals).toBeGreaterThan(0);
  });
});

describe('Blood JUICE — airborne droplet streaks (T79)', () => {
  it('stretches a droplet ALONG velocity: long axis > cross-section, scales with speed', () => {
    const f = settings.dropletStreakLengthFactor;
    const size = settings.dropletSizeMeters;
    const slow = dropletStreakDims(2, size, f);
    const fast = dropletStreakDims(10, size, f);
    expect(slow.long).toBeGreaterThan(slow.cross); // a streak, not a ball
    expect(fast.long).toBeGreaterThan(slow.long); // longer the faster it travels
    // Cross-section stays small (= base size) regardless of speed → it reads as a thin streak.
    expect(slow.cross).toBeCloseTo(size, 6);
    expect(fast.cross).toBeCloseTo(size, 6);
  });

  it('a motionless droplet is not stretched (long == cross)', () => {
    const d = dropletStreakDims(0, settings.dropletSizeMeters, settings.dropletStreakLengthFactor);
    expect(d.long).toBeCloseTo(d.cross, 6);
  });
});

describe('Blood JUICE — player BODY-gore coating (T79)', () => {
  const atPlayer: BloodIngestContext = { ...ctx, playerX: 0, playerZ: 0 };

  it('coats the player body with splats when a spray lands within coat range', () => {
    const s = new BloodSim(settings);
    s.consume([hitReaction(1, 1, 0), bloodSpray(0.5, 0, 0.5)], atPlayer);
    expect(s.playerGoreCount).toBeGreaterThan(0);
    // Offsets are BODY-LOCAL (around + up the body), NOT the world spray coordinate.
    for (let i = 0; i < s.playerGoreCount; i++) {
      const radial = Math.hypot(s.pgX[i]!, s.pgZ[i]!);
      expect(radial).toBeCloseTo(settings.playerGoreBodyRadiusMeters, 5);
      expect(s.pgY[i]!).toBeGreaterThanOrEqual(settings.playerGoreBodyHeightMinMeters - 1e-6);
      expect(s.pgY[i]!).toBeLessThanOrEqual(settings.playerGoreBodyHeightMaxMeters + 1e-6);
    }
  });

  it('does NOT coat the body when the spray is beyond coat range', () => {
    const s = new BloodSim(settings);
    s.consume([hitReaction(1, 1, 0), bloodSpray(settings.coatRangeMeters + 5, 0, 0)], atPlayer);
    expect(s.playerGoreCount).toBe(0);
  });

  it('tracks the player world pos each frame so the body gore can follow it', () => {
    const s = new BloodSim(settings);
    s.consume([], { ...ctx, playerX: 5, playerZ: -3 });
    expect(s.trackedPlayerX).toBe(5);
    expect(s.trackedPlayerZ).toBe(-3);
  });

  it('body gore lingers far longer than floor decals, then dries + shrinks away', () => {
    const s = new BloodSim(settings);
    s.consume([hitReaction(1, 1, 0), bloodSpray(0.2, 0, 0)], atPlayer);
    expect(s.playerGoreCount).toBeGreaterThan(0);
    // Still fully visible after the floor decals would have long since dried out.
    s.update(settings.decalDryTransitionSeconds + settings.decalFreshSeconds);
    let visibleMid = 0;
    for (let i = 0; i < s.playerGoreCount; i++) if (s.pgVis[i]! > 0.3) visibleMid++;
    expect(visibleMid).toBeGreaterThan(0);
    // After its own full life it has shrunk away (vis → 0).
    s.update(settings.playerGoreLifeSeconds * 2);
    for (let i = 0; i < s.playerGoreCount; i++) expect(s.pgVis[i]!).toBe(0);
  });

  it('gore-intensity 0 suppresses body coating (V29)', () => {
    const s = new BloodSim(settings);
    s.consume([hitReaction(1, 1, 0), bloodSpray(0.3, 0, 0)], { ...atPlayer, goreIntensity: 0 });
    expect(s.playerGoreCount).toBe(0);
  });

  it('never exceeds the player-gore pool cap (ring reuse, V24)', () => {
    const s = new BloodSim(settings);
    for (let k = 0; k < 400; k++) s.consume([hitReaction(1, 1, 0), bloodSpray(0.2, 0, 0)], atPlayer);
    expect(s.playerGoreCount).toBeLessThanOrEqual(settings.playerGorePoolSize);
  });
});

describe('Blood JUICE — wetness from coating + puddles (T79)', () => {
  it('builds wetness past the footstep threshold after fighting close to the player', () => {
    const s = new BloodSim(settings);
    const atPlayer: BloodIngestContext = { ...ctx, playerX: 0, playerZ: 0 };
    for (let k = 0; k < 4; k++) s.consume([hitReaction(1, 1, 0), bloodSpray(0.3, 0, 0)], atPlayer);
    expect(s.wetness01).toBeGreaterThan(settings.footstepWetnessThreshold);
  });

  it('picks up wetness from a fresh floor puddle → leaves a footprint trail (no proximity gain at distance)', () => {
    const s = new BloodSim(settings);
    // Spray FAR from the player (ctx player is at 1000,1000) so no proximity wetness is gained.
    for (let k = 0; k < 8; k++) s.consume([hitReaction(1, 1, 0), bloodSpray(20 + k * 0.2, 0, 0)], ctx);
    expect(s.wetness01).toBe(0); // gained nothing from the distant spray
    for (let i = 0; i < 90; i++) s.update(1 / 60); // droplets land → fresh puddles near x≈20
    expect(s.decalCount).toBeGreaterThan(0);
    const before = s.decalCount;
    // Walk the player across the fresh puddle: it soaks them → wetness → footprints.
    for (let k = 0; k < 40; k++) {
      s.consume([], { ...ctx, playerX: 20 + 0.05 * k, playerZ: 0 });
      s.update(1 / 30);
    }
    expect(s.wetness01).toBeGreaterThan(0); // soaked up from the puddle
    expect(s.decalCount).toBeGreaterThan(before); // left a bloody footprint trail
  });
});

describe('BloodSim — bloody footsteps stand-in (T75/V51)', () => {
  it('leaves footprint decals once the player is blood-soaked and moving', () => {
    const s = new BloodSim(settings);
    // Player standing right where the blood lands → builds wetness fast.
    const atPlayer: BloodIngestContext = { ...ctx, playerX: 0, playerZ: 0 };
    for (let k = 0; k < 10; k++) s.consume([hitReaction(1, 1, 0), bloodSpray(0, 0, 0)], atPlayer);
    expect(s.wetness01).toBeGreaterThan(settings.footstepWetnessThreshold);
    const before = s.decalCount;
    // Walk the player a step at a time; consume (no events) updates the tracked position each frame.
    for (let k = 0; k < 30; k++) {
      s.consume([], { ...atPlayer, playerX: 0.1 * k });
      s.update(1 / 30);
    }
    expect(s.decalCount).toBeGreaterThan(before); // footprints stamped while walking
  });
});

describe('BloodSim — zombie body-gore follows the body to the corpse (Bug A)', () => {
  // ctx.playerX/Z sit far away (1000,1000) so the player-coat layer never interferes with these assertions.
  const anchor = (over: Partial<BodyAnchor> = {}): BodyAnchor => ({ x: 2, y: 0, z: 3, heading: 0, lying: 0, groundY: 0, ...over });

  it('creates NO zombie gore until a body-anchor resolver is wired (no regression)', () => {
    const s = new BloodSim(settings);
    s.consume([hitReaction(1), bloodSpray(2, 0, 3)], ctx);
    expect(s.zombieGoreCount).toBe(0);
  });

  it('sticks gore to the struck body, then drops it to the floor when the body topples to a corpse', () => {
    const s = new BloodSim(settings);
    let body: BodyAnchor | null = anchor({ lying: 0 }); // upright zombie
    s.setBodyAnchors({ resolve: (e) => (e === 7 ? body : null) });
    s.consume([hitReaction(1), bloodSpray(2, 0, 3)], ctx);
    expect(s.zombieGoreCount).toBeGreaterThan(0);

    // Upright: gore sits UP the body, well above the floor.
    s.update(1 / 60);
    let maxY = 0;
    for (let i = 0; i < s.zombieGoreCount; i++) maxY = Math.max(maxY, s.zgWY[i]!);
    expect(maxY).toBeGreaterThanOrEqual(settings.playerGoreBodyHeightMinMeters);

    // The body topples to a corpse lying on a slab at y=0.2 — the gore drops WITH it (not frozen mid-air).
    body = anchor({ lying: 1, groundY: 0.2 });
    s.update(1 / 60);
    for (let i = 0; i < s.zombieGoreCount; i++) expect(s.zgWY[i]!).toBeLessThan(0.6);
  });

  it('keeps the gore at the body wherever it moves (re-projected each frame, not parented)', () => {
    const s = new BloodSim(settings);
    let body = anchor({ x: 0, y: 0, z: 0 });
    s.setBodyAnchors({ resolve: (e) => (e === 7 ? body : null) });
    s.consume([hitReaction(1), bloodSpray(0, 0, 0)], ctx);
    s.update(1 / 60);
    // Move the live body 10 m in x; the gore tracks it (its world x shifts by ~10).
    body = anchor({ x: 10, y: 0, z: 0 });
    s.update(1 / 60);
    for (let i = 0; i < s.zombieGoreCount; i++) expect(s.zgWX[i]!).toBeGreaterThan(8);
  });

  it('collapses gore to nothing when the body is gone (resolver → null) — never frozen in mid-air', () => {
    const s = new BloodSim(settings);
    let alive = true;
    s.setBodyAnchors({ resolve: (e) => (alive && e === 7 ? anchor() : null) });
    s.consume([hitReaction(1), bloodSpray(2, 0, 3)], ctx);
    s.update(1 / 60);
    expect(s.zombieGoreCount).toBeGreaterThan(0);
    alive = false;
    s.update(1 / 60);
    for (let i = 0; i < s.zombieGoreCount; i++) expect(s.zgVis[i]!).toBe(0); // every splat invisible, not stuck
  });

  it('WORLD floor decals stay in world space — only BODY gore follows the anchor', () => {
    const s = new BloodSim(settings);
    s.setBodyAnchors({ resolve: () => anchor({ x: 999, y: 999, z: 999, groundY: 999 }) });
    s.consume([hitReaction(1, 1, 0), bloodSpray(0, 0, 0)], ctx);
    for (let i = 0; i < 120; i++) s.update(1 / 60);
    expect(s.decalCount).toBeGreaterThan(0);
    for (let i = 0; i < s.decalCount; i++) {
      expect(Math.abs(s.cx[i]!)).toBeLessThan(50); // decals near the impact (0,0), NOT teleported to the body
      expect(Math.abs(s.cz[i]!)).toBeLessThan(50);
    }
  });
});
