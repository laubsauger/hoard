// T57 / V16 / V17 — combat lethality + reactions: non-head hits wound/stagger (not instakill),
// head stays lethal, accumulating body damage kills, wound state drives behaviour (Stagger).
import { describe, it, expect } from 'vitest';
import { CombatSystem, type CombatDeps } from '@/game/combat';
import { SimulationZombies, SimTier, ZombieState, type ZombieSlot } from '@/game/simulation';
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
    firstProjectileBlockerDistance: () => null,
  };
  const sys = new CombatSystem(deps);
  return { zombies, spatial, sys, weapons, combat, visual };
}

function spawn(h: ReturnType<typeof harness>, x: number, z: number): ZombieSlot {
  const slot = h.zombies.spawn({
    archetype: 0,
    position: [x, 0, z],
    health: h.combat.zombieBaseHealth,
    simTier: SimTier.Hero,
  });
  h.spatial.insert({ id: slot, x, z, radius: 0.35, yMin: 0, yMax: 1.8, layers: AGENT_LAYERS });
  return slot;
}

const ORIGIN = { x: 0, y: 1.6, z: 0 };

describe('T57 non-head hit wounds + staggers, never instakills (V16/V17)', () => {
  it('a torso hit drops health, leaves the body alive, and knocks it into a stagger', () => {
    const h = harness();
    const slot = spawn(h, 5, 0);
    const res = h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');

    expect(res.hit).toBe(true);
    expect(res.killed).toBe(false); // not an instakill
    expect(h.zombies.getHealth(slot)).toBeLessThan(h.combat.zombieBaseHealth); // wounded
    expect(h.zombies.getHealth(slot)).toBeGreaterThan(0); // still alive
    expect(res.staggered).toBe(true);
    expect(h.zombies.getState(slot)).toBe(ZombieState.Stagger); // wound state drives behaviour
    expect(h.zombies.getStateTimer(slot)).toBeCloseTo(h.combat.staggerDurationSeconds, 5);
    expect(h.visual.some((e) => e.kind === 'hitReaction')).toBe(true); // hitReaction per resolved hit
  });
});

describe('T57 head hit stays lethal in one shot (V17)', () => {
  it('a single head hit kills regardless of remaining health', () => {
    const h = harness();
    const slot = spawn(h, 5, 0);
    const res = h.sys.fire(ORIGIN, 1, 0, 'head');
    expect(res.killed).toBe(true);
    expect(res.staggered).toBeFalsy(); // dead bodies do not stagger
    expect(h.zombies.isAlive(slot)).toBe(false);
  });
});

describe('T57 accumulating body damage eventually kills (a body takes a few shots)', () => {
  it('takes more than one torso shot, but accumulated damage kills', () => {
    const h = harness();
    const slot = spawn(h, 5, 0);

    let shots = 0;
    let killed = false;
    for (let i = 0; i < 16 && !killed; i++) {
      const res = h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
      shots += 1;
      killed = res.killed === true;
    }

    expect(killed).toBe(true);
    expect(shots).toBeGreaterThan(1); // a body survives a single torso shot (no instakill)
    expect(h.zombies.isAlive(slot)).toBe(false);
  });
});
