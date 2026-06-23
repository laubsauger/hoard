// T16 / V16 — combat hit-pipeline invariants.
import { describe, it, expect } from 'vitest';
import { CombatSystem, regionBit, type CombatDeps } from '@/game/combat';
import { SimulationZombies, SimTier, type ZombieSlot } from '@/game/simulation';
import { SpatialHash, CollisionLayer, layerMask } from '@/game/navigation/collision';
import { resolveDomain } from '@/config/registry';
import { weaponsConfig } from '@/config/domains/weapons';
import { combatConfig } from '@/config/domains/combat';
import type { EntityId, EventId, VisualEvent, WorldEvent } from '@/game/core/contracts';

const AGENT_LAYERS = layerMask(CollisionLayer.Movement, CollisionLayer.Projectile, CollisionLayer.Attack);

function harness(opts: { withPromote?: boolean; blockerDistance?: number | null } = {}) {
  const zombies = new SimulationZombies(64);
  const spatial = new SpatialHash({ cellSize: 2 });
  const weapons = resolveDomain(weaponsConfig, 'desktop-high');
  const combat = resolveDomain(combatConfig, 'desktop-high');
  const world: WorldEvent[] = [];
  const visual: VisualEvent[] = [];
  const dead: ZombieSlot[] = [];
  const damaged: ZombieSlot[] = [];
  const promoted: ZombieSlot[] = [];
  let ev = 0;
  const deps: CombatDeps = {
    zombies,
    spatial,
    weapons,
    combat,
    entityOf: (s) => s as unknown as EntityId,
    nextEventId: () => ev++ as unknown as EventId,
    worldEvents: { push: (e) => (world.push(e), true) },
    visualEvents: { push: (e) => (visual.push(e), true) },
    onDamaged: (s) => damaged.push(s),
    onEntityDied: (s) => {
      dead.push(s);
      spatial.remove(s);
      zombies.free(s);
    },
    // Default: line of fire is clear (null). Tests override with a finite blocker distance.
    firstProjectileBlockerDistance: () => opts.blockerDistance ?? null,
    ...(opts.withPromote ? { promote: (s: ZombieSlot) => promoted.push(s) } : {}),
  };
  const sys = new CombatSystem(deps);
  return { zombies, spatial, sys, world, visual, dead, damaged, promoted, weapons, combat };
}

function spawn(
  h: ReturnType<typeof harness>,
  x: number,
  z: number,
  opts: { health?: number; flags?: number; tier?: SimTier } = {},
): ZombieSlot {
  const slot = h.zombies.spawn({
    archetype: 0,
    position: [x, 0, z],
    health: opts.health ?? 100,
    anatomyFlags: opts.flags ?? 0,
    simTier: opts.tier ?? SimTier.Hero,
  });
  h.spatial.insert({ id: slot, x, z, radius: 0.35, yMin: 0, yMax: 1.8, layers: AGENT_LAYERS });
  return slot;
}

const ORIGIN = { x: 0, y: 1.6, z: 0 };

describe('V16 candidate gather — only intersected cells', () => {
  it('gathers bodies near the ray, never the whole grid', () => {
    const h = harness();
    const target = spawn(h, 5, 0); // on the ray (dir +x)
    const nearMiss = spawn(h, 5, 2); // gathered (adjacent cell) but outside line-of-fire radius
    const farAway = spawn(h, 5, 50); // 25 cells off-ray — must NOT be gathered

    const res = h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');

    expect(res.hit).toBe(true);
    expect(res.targetSlot).toBe(target);
    // candidateCount counts ONLY the swept-cell gather (target + near-miss), not the distant body.
    expect(res.candidateCount).toBe(2);
    expect(h.zombies.isAlive(nearMiss)).toBe(true);
    expect(h.zombies.getHealth(nearMiss)).toBe(100);
    expect(h.zombies.getHealth(farAway)).toBe(100); // never even gathered
  });

  it('orders penetrating hits by projectile travel', () => {
    const h = harness();
    const near = spawn(h, 4, 0, { health: 10_000 });
    const far = spawn(h, 8, 0, { health: 10_000 });
    const shots = h.sys.firePenetrating(ORIGIN, 1, 0, 'torsoUpper');
    expect(shots.map((s) => s.targetSlot)).toEqual([near, far]);
    expect(shots[0]!.travelMeters!).toBeLessThan(shots[1]!.travelMeters!);
  });
});

describe('V16 line-of-fire penetration + falloff', () => {
  it('penetrates up to firearmMaxPenetrations bodies with decreasing damage', () => {
    const h = harness();
    spawn(h, 3, 0, { health: 10_000 });
    spawn(h, 6, 0, { health: 10_000 });
    spawn(h, 9, 0, { health: 10_000 }); // beyond max penetrations (default 2)
    const shots = h.sys.firePenetrating(ORIGIN, 1, 0, 'torsoUpper');
    expect(shots).toHaveLength(h.weapons.firearmMaxPenetrations);
    expect(shots[1]!.effectiveDamage!).toBeLessThan(shots[0]!.effectiveDamage!);
  });
});

describe('V16 tier hit-volume filter + promotion', () => {
  it('promotes a horde-tier target to hero when a detailed region is aimed', () => {
    const h = harness({ withPromote: true });
    const slot = spawn(h, 5, 0, { tier: SimTier.VisibleHorde });
    const [shot] = h.sys.firePenetrating(ORIGIN, 1, 0, 'armLeft'); // arm not exposed at horde tier
    expect(shot!.promoted).toBe(true);
    expect(shot!.region).toBe('armLeft'); // resolved at full detail after promotion
    expect(h.promoted).toContain(slot);
  });

  it('coarsens the region when promotion is unavailable', () => {
    const h = harness(); // no promote dep
    spawn(h, 5, 0, { tier: SimTier.VisibleHorde });
    const [shot] = h.sys.firePenetrating(ORIGIN, 1, 0, 'armLeft');
    expect(shot!.promoted).toBe(false);
    expect(shot!.region).toBe('torsoUpper'); // collapsed to the coarse body volume
  });
});

describe('V16 posture term in resolution', () => {
  it('a downed/crawling target takes more damage than a standing one', () => {
    const standing = harness();
    spawn(standing, 5, 0);
    const sShot = standing.sys.firePenetrating(ORIGIN, 1, 0, 'torsoUpper')[0]!;

    const crawling = harness();
    spawn(crawling, 5, 0, { flags: regionBit('legLeft') | regionBit('legRight') });
    const cShot = crawling.sys.firePenetrating(ORIGIN, 1, 0, 'torsoUpper')[0]!;

    expect(cShot.effectiveDamage!).toBeGreaterThan(sShot.effectiveDamage!);
  });
});

describe('V53/B20 structure occlusion — shots do not pass through walls', () => {
  it('a blocking wall between shooter and target → no hit, stop distance = wall distance', () => {
    const h = harness({ blockerDistance: 4 }); // wall at 4 m
    spawn(h, 5, 0); // target beyond the wall
    const res = h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    expect(res.hit).toBe(false);
    expect(res.stopDistanceMeters).toBe(4);
  });

  it('breaching that cell (query clear) → the target IS hit', () => {
    const h = harness({ blockerDistance: null }); // breach restores the line locally (V5)
    const slot = spawn(h, 5, 0);
    const res = h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    expect(res.hit).toBe(true);
    expect(res.targetSlot).toBe(slot);
    expect(h.zombies.getHealth(slot)).toBeLessThan(100);
  });

  it('a closed door blocks; an open/broken door does not', () => {
    const closed = harness({ blockerDistance: 3 }); // closed/locked door at 3 m
    spawn(closed, 5, 0);
    expect(closed.sys.fire(ORIGIN, 1, 0, 'torsoUpper').hit).toBe(false);

    const open = harness({ blockerDistance: null }); // open/broken door = passable
    spawn(open, 5, 0);
    expect(open.sys.fire(ORIGIN, 1, 0, 'torsoUpper').hit).toBe(true);
  });

  it('penetration still works among bodies BEFORE the wall, but stops at it', () => {
    const h = harness({ blockerDistance: 7 }); // wall at 7 m
    const a = spawn(h, 3, 0, { health: 10_000 });
    const b = spawn(h, 6, 0, { health: 10_000 });
    spawn(h, 9, 0, { health: 10_000 }); // beyond the wall — must NOT be touched
    const shots = h.sys.firePenetrating(ORIGIN, 1, 0, 'torsoUpper');
    expect(shots.map((s) => s.targetSlot)).toEqual([a, b]);
    expect(shots.every((s) => s.stopDistanceMeters === 3)).toBe(true); // first body struck
  });

  it('a wall before the bodies stops penetration entirely', () => {
    const h = harness({ blockerDistance: 5 }); // wall at 5 m, both bodies behind it
    spawn(h, 6, 0, { health: 10_000 });
    spawn(h, 8, 0, { health: 10_000 });
    expect(h.sys.firePenetrating(ORIGIN, 1, 0, 'torsoUpper')).toHaveLength(0);
  });

  it('clean miss (no body, clear line) → stop distance = weapon range', () => {
    const h = harness({ blockerDistance: null });
    const res = h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    expect(res.hit).toBe(false);
    expect(res.stopDistanceMeters).toBe(h.weapons.firearmRangeMeters);
  });
});
