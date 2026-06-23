// T18 / V16 / V28 — weapons: ammo, melee attack-window gating, penetration, sound stimulus.
import { describe, it, expect } from 'vitest';
import { CombatSystem, WeaponSystem, type CombatDeps } from '@/game/combat';
import { SimulationZombies, SimTier, type ZombieSlot } from '@/game/simulation';
import { SpatialHash, CollisionLayer, layerMask } from '@/game/navigation/collision';
import { StimulusField } from '@/game/stimulus';
import { IdFactory } from '@/game/core';
import { resolveDomain } from '@/config/registry';
import { weaponsConfig } from '@/config/domains/weapons';
import { combatConfig } from '@/config/domains/combat';
import type { EntityId, EventId, StimulusId, VisualEvent, WorldEvent } from '@/game/core/contracts';

const AGENT_LAYERS = layerMask(CollisionLayer.Movement, CollisionLayer.Projectile, CollisionLayer.Attack);

function harness() {
  const zombies = new SimulationZombies(32);
  const spatial = new SpatialHash({ cellSize: 2 });
  const weapons = resolveDomain(weaponsConfig, 'desktop-high');
  const combatCfg = resolveDomain(combatConfig, 'desktop-high');
  const ids = new IdFactory();
  const field = new StimulusField(64);
  let ev = 0;
  let now = 0;
  const world: WorldEvent[] = [];
  const visual: VisualEvent[] = [];
  const deps: CombatDeps = {
    zombies,
    spatial,
    weapons,
    combat: combatCfg,
    entityOf: (s) => s as unknown as EntityId,
    nextEventId: () => ev++ as unknown as EventId,
    worldEvents: { push: (e) => (world.push(e), true) },
    visualEvents: { push: (e) => (visual.push(e), true) },
    onDamaged: () => {},
    onEntityDied: (s) => {
      spatial.remove(s);
      zombies.free(s);
    },
    firstProjectileBlockerDistance: () => null, // clear line of fire for the weapon-system cases
  };
  const combat = new CombatSystem(deps);
  const weaponSys = new WeaponSystem({
    combat,
    stimulus: field,
    weapons,
    combatCfg,
    nextStimulusId: () => ids.next<StimulusId>('stimulus'),
    nowTick: () => now,
  });
  return {
    zombies,
    spatial,
    combat,
    weaponSys,
    field,
    weapons,
    combatCfg,
    setTick: (t: number) => (now = t),
  };
}

function spawn(h: ReturnType<typeof harness>, x: number, z: number, health = 100): ZombieSlot {
  const slot = h.zombies.spawn({ archetype: 0, position: [x, 0, z], health, simTier: SimTier.Hero });
  h.spatial.insert({ id: slot, x, z, radius: 0.35, yMin: 0, yMax: 1.8, layers: AGENT_LAYERS });
  return slot;
}

const ORIGIN = { x: 0, y: 1.6, z: 0 };

describe('T18 firearm ammo', () => {
  it('fires until the magazine is empty, then refuses to fire', () => {
    const h = harness();
    spawn(h, 5, 0, 1e9);
    const cap = h.weapons.firearmMagazineSize;
    for (let i = 0; i < cap; i++) {
      expect(h.weaponSys.fireFirearm(ORIGIN, 1, 0, 'torsoUpper').fired).toBe(true);
    }
    const empty = h.weaponSys.fireFirearm(ORIGIN, 1, 0, 'torsoUpper');
    expect(empty.fired).toBe(false);
    expect(empty.reason).toBe('empty');
    h.weaponSys.reload();
    expect(h.weaponSys.fireFirearm(ORIGIN, 1, 0, 'torsoUpper').fired).toBe(true);
  });
});

describe('V28 weapon sound stimulus', () => {
  it('a gunshot emits a queryable gunfire sound stimulus (attracts the horde)', () => {
    const h = harness();
    spawn(h, 5, 0, 1e9);
    const before = h.field.activeCount;
    const out = h.weaponSys.fireFirearm(ORIGIN, 1, 0, 'torsoUpper');
    expect(out.soundId).toBeDefined();
    expect(h.field.activeCount).toBe(before + 1);
    const heard = h.field.query(ORIGIN.x, ORIGIN.z, 0);
    expect(heard.some((s) => s.stimulus.source === 'gunfire' && s.stimulus.kind === 'sound')).toBe(true);
  });
});

describe('V16 melee damage ONLY in the active attack-volume window', () => {
  it('windup deals no damage; the active window resolves exactly once', () => {
    const h = harness();
    const target = spawn(h, 1, 0); // within melee range, straight ahead
    h.setTick(0);
    h.weaponSys.startSwing(0, 1, 0);

    // windup phase — no damage (navigation overlap must never deal damage, V16)
    h.setTick(1);
    let out = h.weaponSys.updateSwing(1, ORIGIN, 'torsoUpper');
    expect(out.resolved).toBe(false);
    expect(h.zombies.getHealth(target)).toBe(100);

    // first active tick (windup default 3) — resolves + damages
    const windup = h.combatCfg.meleeWindupTicks;
    h.setTick(windup);
    out = h.weaponSys.updateSwing(windup, ORIGIN, 'torsoUpper');
    expect(out.resolved).toBe(true);
    expect(out.shots.length).toBe(1);
    const afterFirst = h.zombies.getHealth(target);
    expect(afterFirst).toBeLessThan(100);

    // a later active tick does NOT re-apply damage (single resolve per swing)
    h.setTick(windup + 1);
    out = h.weaponSys.updateSwing(windup + 1, ORIGIN, 'torsoUpper');
    expect(out.resolved).toBe(false);
    expect(h.zombies.getHealth(target)).toBe(afterFirst);
  });

  it('a melee sweep strikes every body inside the arc', () => {
    const h = harness();
    spawn(h, 1, 0.2);
    spawn(h, 1, -0.2);
    spawn(h, -1, 0); // behind the swing — outside the forward arc
    h.setTick(0);
    h.weaponSys.startSwing(0, 1, 0);
    const windup = h.combatCfg.meleeWindupTicks;
    h.setTick(windup);
    const out = h.weaponSys.updateSwing(windup, ORIGIN, 'torsoUpper');
    expect(out.shots.length).toBe(2); // the two in front, not the one behind
  });
});
