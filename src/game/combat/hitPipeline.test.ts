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

function harness(opts: { withPromote?: boolean } = {}) {
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
