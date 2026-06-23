// T73 / V50 — per-weapon ballistics: penetration budget (stopping power), pellets/spread, distance falloff.
import { describe, it, expect } from 'vitest';
import { CombatSystem, type CombatDeps } from '@/game/combat';
import { SimulationZombies, SimTier, type ZombieSlot } from '@/game/simulation';
import { SpatialHash, CollisionLayer, layerMask } from '@/game/navigation/collision';
import { resolveDomain } from '@/config/registry';
import { weaponsConfig } from '@/config/domains/weapons';
import { combatConfig } from '@/config/domains/combat';
import type { EntityId, EventId, VisualEvent, WorldEvent } from '@/game/core/contracts';

const AGENT_LAYERS = layerMask(CollisionLayer.Movement, CollisionLayer.Projectile, CollisionLayer.Attack);

function harness() {
  const zombies = new SimulationZombies(64);
  const spatial = new SpatialHash({ cellSize: 2 });
  const weapons = resolveDomain(weaponsConfig, 'desktop-high');
  const combat = resolveDomain(combatConfig, 'desktop-high');
  const world: WorldEvent[] = [];
  const visual: VisualEvent[] = [];
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
    onDamaged: () => {},
    onEntityDied: (s) => {
      spatial.remove(s);
      zombies.free(s);
    },
    firstProjectileBlockerDistance: () => null, // clear line of fire
  };
  const sys = new CombatSystem(deps);
  return { zombies, spatial, sys, weapons, combat };
}

function spawn(h: ReturnType<typeof harness>, x: number, z: number, health = 1_000_000): ZombieSlot {
  const slot = h.zombies.spawn({ archetype: 0, position: [x, 0, z], health, simTier: SimTier.Hero });
  h.spatial.insert({ id: slot, x, z, radius: 0.35, yMin: 0, yMax: 1.8, layers: AGENT_LAYERS });
  return slot;
}

const ORIGIN = { x: 0, y: 1.6, z: 0 };

describe('T73 weapon registry + equip (V50)', () => {
  it('defaults to the pistol and exposes the equipped class model', () => {
    const h = harness();
    expect(h.sys.currentWeapon().id).toBe('pistol');
    h.sys.setWeapon('rifle');
    expect(h.sys.currentWeapon().id).toBe('rifle');
    expect(h.sys.currentWeapon().stoppingPower).toBeGreaterThan(h.weapons.pistolStoppingPower);
  });

  it('rejects an unknown weapon id (no silent fallback)', () => {
    const h = harness();
    expect(() => h.sys.setWeapon('bazooka' as never)).toThrow();
  });
});

describe('T73 penetration budget — stopping power per body (V50)', () => {
  it('a pistol stops at the FIRST body (1-body budget)', () => {
    const h = harness(); // pistol equipped by default
    const a = spawn(h, 3, 0);
    const b = spawn(h, 6, 0); // directly behind a, on the ray
    const res = h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    expect(res.hit).toBe(true);
    expect(res.targetSlot).toBe(a);
    expect(h.zombies.getHealth(a)).toBeLessThan(1_000_000); // struck
    expect(h.zombies.getHealth(b)).toBe(1_000_000); // shot stopped — never reached
  });

  it('a rifle pierces SEVERAL bodies along the line of fire', () => {
    const h = harness();
    h.sys.setWeapon('rifle');
    const a = spawn(h, 3, 0);
    const b = spawn(h, 6, 0);
    const c = spawn(h, 9, 0);
    h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    // rifle stopping power (4) > 3 bodies × resistance (1) → all three are struck.
    expect(h.zombies.getHealth(a)).toBeLessThan(1_000_000);
    expect(h.zombies.getHealth(b)).toBeLessThan(1_000_000);
    expect(h.zombies.getHealth(c)).toBeLessThan(1_000_000);
  });

  it('the rifle pierces strictly more bodies than the pistol on the same line', () => {
    const pistolH = harness();
    spawn(pistolH, 3, 0);
    spawn(pistolH, 6, 0);
    spawn(pistolH, 9, 0);
    pistolH.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    const pistolStruck = [...pistolH.zombies.aliveSlots()].filter(
      (s) => pistolH.zombies.getHealth(s) < 1_000_000,
    ).length;

    const rifleH = harness();
    rifleH.sys.setWeapon('rifle');
    spawn(rifleH, 3, 0);
    spawn(rifleH, 6, 0);
    spawn(rifleH, 9, 0);
    rifleH.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    const rifleStruck = [...rifleH.zombies.aliveSlots()].filter(
      (s) => rifleH.zombies.getHealth(s) < 1_000_000,
    ).length;

    expect(pistolStruck).toBe(1);
    expect(rifleStruck).toBeGreaterThan(pistolStruck);
  });
});

describe('T73 shotgun pellet spread (V50)', () => {
  it('fires multiple pellets in a spread that hit OFF-AXIS bodies a single shot would miss', () => {
    // Two bodies offset laterally beyond the single-ray line-of-fire radius (centre ray misses both).
    const pistolH = harness();
    const pa = spawn(pistolH, 10, 1.2);
    const pb = spawn(pistolH, 10, -1.2);
    pistolH.sys.fire(ORIGIN, 1, 0, 'torsoUpper'); // pistol: one centre ray
    expect(pistolH.zombies.getHealth(pa)).toBe(1_000_000); // outside the single ray → untouched
    expect(pistolH.zombies.getHealth(pb)).toBe(1_000_000);

    const shotgunH = harness();
    shotgunH.sys.setWeapon('shotgun');
    const sa = spawn(shotgunH, 10, 1.2);
    const sb = spawn(shotgunH, 10, -1.2);
    shotgunH.sys.fire(ORIGIN, 1, 0, 'torsoUpper'); // shotgun: spread cone reaches both
    expect(shotgunH.zombies.getHealth(sa)).toBeLessThan(1_000_000);
    expect(shotgunH.zombies.getHealth(sb)).toBeLessThan(1_000_000);
  });
});

describe('T73 distance damage falloff (V50)', () => {
  it('the same weapon deals less effective damage to a farther body', () => {
    const near = harness();
    near.sys.setWeapon('rifle');
    spawn(near, 5, 0);
    const nearShot = near.sys.fire(ORIGIN, 1, 0, 'torsoUpper');

    const far = harness();
    far.sys.setWeapon('rifle');
    spawn(far, 100, 0);
    const farShot = far.sys.fire(ORIGIN, 1, 0, 'torsoUpper');

    expect(nearShot.effectiveDamage!).toBeGreaterThan(farShot.effectiveDamage!);
  });
});

describe('T73 stop distance is returned for the tracer (V49/V53)', () => {
  it('reports the struck-body travel on a hit and the weapon range on a clean miss', () => {
    const hit = harness();
    spawn(hit, 7, 0);
    const hitRes = hit.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    expect(hitRes.hit).toBe(true);
    expect(hitRes.stopDistanceMeters).toBeCloseTo(7, 5);

    const miss = harness();
    const missRes = miss.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    expect(missRes.hit).toBe(false);
    expect(missRes.stopDistanceMeters).toBe(miss.sys.currentWeapon().rangeMeters);
  });
});
