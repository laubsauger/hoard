// T134 — the corpse ragdoll impulse (`DeathImpact.force`) is the EQUIPPED weapon's knockback ENERGY, decoupled
// from damage, so each weapon has its own kinetic signature (a pistol topples, a shotgun launches). V109: the
// impulse is scaled by hit CLOSENESS — `knockback × max(floor, 1 − travel/range)` — so a point-blank kill
// LAUNCHES the body and a far one keeps only the floor fraction. These hits are at a known distance, so the
// expected force is the configured knockback × that closeness factor.
import { describe, it, expect } from 'vitest';
import { CombatSystem, type CombatDeps, type DeathImpact } from '@/game/combat';
import { SimulationZombies, SimTier, type ZombieSlot } from '@/game/simulation';
import { SpatialHash, CollisionLayer, layerMask } from '@/game/navigation/collision';
import { resolveDomain } from '@/config/registry';
import { weaponsConfig } from '@/config/domains/weapons';
import { combatConfig } from '@/config/domains/combat';
import type { EntityId, EventId, VisualEvent, WorldEvent } from '@/game/core/contracts';

const AGENT_LAYERS = layerMask(CollisionLayer.Movement, CollisionLayer.Projectile, CollisionLayer.Attack);

function harness() {
  const zombies = new SimulationZombies(32);
  const spatial = new SpatialHash({ cellSize: 2 });
  const weapons = resolveDomain(weaponsConfig, 'desktop-high');
  const combat = resolveDomain(combatConfig, 'desktop-high');
  const impacts: DeathImpact[] = [];
  let ev = 0;
  const deps: CombatDeps = {
    zombies,
    spatial,
    weapons,
    combat,
    entityOf: (s) => s as unknown as EntityId,
    nextEventId: () => ev++ as unknown as EventId,
    worldEvents: { push: (_e: WorldEvent) => true },
    visualEvents: { push: (_e: VisualEvent) => true },
    onDamaged: () => {},
    onEntityDied: (s, impact) => {
      if (impact) impacts.push(impact);
      spatial.remove(s);
      zombies.free(s);
    },
    firstProjectileBlockerDistance: () => null,
  };
  const sys = new CombatSystem(deps);
  return { zombies, spatial, sys, weapons, impacts };
}

function spawn(h: ReturnType<typeof harness>, x: number, z: number): ZombieSlot {
  const slot = h.zombies.spawn({ archetype: 0, position: [x, 0, z], health: 60, simTier: SimTier.Hero });
  h.spatial.insert({ id: slot, x, z, radius: 0.35, yMin: 0, yMax: 1.8, layers: AGENT_LAYERS });
  return slot;
}

const ORIGIN = { x: 0, y: 1.6, z: 0 };

describe('T134 death impact carries the firing weapon knockback (not raw damage)', () => {
  it('a pistol headshot surfaces the pistol knockback along the shot direction', () => {
    const h = harness();
    spawn(h, 5, 0);
    const res = h.sys.fire(ORIGIN, 1, 0, 'head');
    expect(res.killed).toBe(true);
    expect(h.impacts).toHaveLength(1);
    const im = h.impacts[0]!;
    expect(im.force).toBeCloseTo(h.weapons.pistolKnockback * (1 - 5 / h.weapons.pistolRangeMeters), 1); // V109 closeness-scaled, NOT damage
    expect(im.dirX).toBeCloseTo(1, 2); // along the shot (a sub-degree accuracy spread perturbs it slightly)
    expect(im.dirZ).toBeCloseTo(0, 2);
  });

  it('switching to the shotgun launches the corpse harder than the pistol (distinct per-weapon energy)', () => {
    const h = harness();
    spawn(h, 5, 0);
    h.sys.setWeapon('shotgun');
    const res = h.sys.fire(ORIGIN, 1, 0, 'head');
    expect(res.killed).toBe(true);
    expect(h.impacts[0]!.force).toBeCloseTo(h.weapons.shotgunKnockback * (1 - 5 / h.weapons.shotgunRangeMeters), 1);
    expect(h.weapons.shotgunKnockback).toBeGreaterThan(h.weapons.pistolKnockback); // shotgun knocks back hardest
  });

  it('a melee kill carries the blunt melee knockback', () => {
    const h = harness();
    spawn(h, 1, 0);
    h.sys.setWeapon('melee');
    const res = h.sys.fire(ORIGIN, 1, 0, 'head');
    expect(res.killed).toBe(true);
    expect(h.impacts[0]!.force).toBeCloseTo(h.weapons.meleeClassKnockback * Math.max(0.35, 1 - 1 / h.weapons.meleeClassRangeMeters), 1);
  });
});
