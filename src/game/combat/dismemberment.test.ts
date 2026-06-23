// T17 / V17 — anatomy + dismemberment invariants.
import { describe, it, expect } from 'vitest';
import {
  CombatSystem,
  isSevered,
  regionBit,
  limbConsequences,
  Posture,
  DetachedPartPool,
  buildSegments,
  type CombatDeps,
} from '@/game/combat';
import { SimulationZombies, SimTier, type ZombieSlot } from '@/game/simulation';
import { SpatialHash, CollisionLayer, layerMask } from '@/game/navigation/collision';
import { resolveDomain } from '@/config/registry';
import { weaponsConfig } from '@/config/domains/weapons';
import { combatConfig } from '@/config/domains/combat';
import type { EntityId, EventId, VisualEvent, WorldEvent } from '@/game/core/contracts';

const AGENT_LAYERS = layerMask(CollisionLayer.Movement, CollisionLayer.Projectile, CollisionLayer.Attack);
const COMBAT_CFG = resolveDomain(combatConfig, 'desktop-high');

function harness() {
  const zombies = new SimulationZombies(16);
  const spatial = new SpatialHash({ cellSize: 2 });
  const world: WorldEvent[] = [];
  const visual: VisualEvent[] = [];
  const dead: ZombieSlot[] = [];
  let ev = 0;
  const deps: CombatDeps = {
    zombies,
    spatial,
    weapons: resolveDomain(weaponsConfig, 'desktop-high'),
    combat: COMBAT_CFG,
    entityOf: (s) => s as unknown as EntityId,
    nextEventId: () => ev++ as unknown as EventId,
    worldEvents: { push: (e) => (world.push(e), true) },
    visualEvents: { push: (e) => (visual.push(e), true) },
    onDamaged: () => {},
    onEntityDied: (s) => {
      dead.push(s);
      spatial.remove(s);
      zombies.free(s);
    },
    firstProjectileBlockerDistance: () => null, // clear line of fire for these dismemberment cases
  };
  const sys = new CombatSystem(deps);
  const slot = zombies.spawn({ archetype: 0, position: [5, 0, 0], health: 100, simTier: SimTier.Hero });
  spatial.insert({ id: slot, x: 5, z: 0, radius: 0.35, yMin: 0, yMax: 1.8, layers: AGENT_LAYERS });
  return { zombies, sys, slot, world, visual, dead };
}

const ORIGIN = { x: 0, y: 1.6, z: 0 };

describe('V17 head destruction is fatal + sets anatomyFlags', () => {
  it('a headshot kills regardless of remaining health and flags the head severed', () => {
    const h = harness();
    const res = h.sys.fire(ORIGIN, 1, 0, 'head');
    expect(res.killed).toBe(true);
    expect(res.severed).toBe(true);
    expect(h.dead).toContain(h.slot);
    // anatomyFlags recorded the sever bit (checked before free via the world event severed flag)
    const hit = h.world.find((e) => e.kind === 'hitResolved');
    expect(hit && hit.kind === 'hitResolved' && hit.severed).toBe(true);
  });

  it('emits a partDetached visual event when a limb is severed', () => {
    const h = harness();
    const res = h.sys.fire(ORIGIN, 1, 0, 'armLeft');
    expect(res.severed).toBe(true);
    expect(res.killed).toBe(false);
    expect(isSevered(h.zombies.getAnatomyFlags(h.slot), 'armLeft')).toBe(true);
    expect(h.visual.some((e) => e.kind === 'partDetached')).toBe(true);
  });
});

describe('V17 missing-limb consequences', () => {
  it('lost legs reduce locomotion and force a crawl posture', () => {
    const flags = regionBit('legLeft') | regionBit('legRight');
    const c = limbConsequences(flags, COMBAT_CFG);
    expect(c.legsLost).toBe(2);
    expect(c.posture).toBe(Posture.Crawling);
    expect(c.locomotionScale).toBeLessThan(1);
  });

  it('lost arms reduce threat and disable standing attack', () => {
    const flags = regionBit('armLeft') | regionBit('armRight');
    const c = limbConsequences(flags, COMBAT_CFG);
    expect(c.armsLost).toBe(2);
    expect(c.threatScale).toBeLessThan(1);
    expect(c.canAttack).toBe(false);
  });

  it('an intact body has full locomotion + threat', () => {
    const c = limbConsequences(0, COMBAT_CFG);
    expect(c.locomotionScale).toBe(1);
    expect(c.threatScale).toBe(1);
    expect(c.posture).toBe(Posture.Standing);
    expect(c.canAttack).toBe(true);
  });
});

describe('V17/V18 segments + pooled detached parts', () => {
  it('every region has bone + render ownership metadata', () => {
    const segs = buildSegments();
    expect(segs.head.bone).toBeTruthy();
    expect(segs.head.renderNode).toBeTruthy();
    expect(segs.head.fatal).toBe(true);
    expect(segs.torsoUpper.severable).toBe(false);
    expect(segs.armLeft.severable).toBe(true);
  });

  it('detached parts settle to cheap props after the active window', () => {
    const pool = new DetachedPartPool({ capacity: 8, settleTicks: 10 });
    pool.detach(1 as unknown as EntityId, 'armLeft', 5, 0, 0, 0);
    pool.detach(2 as unknown as EntityId, 'legRight', 6, 0, 0, 0);
    expect(pool.activeCount).toBe(2);
    expect(pool.settledCount).toBe(0);
    pool.update(5);
    expect(pool.activeCount).toBe(2); // not yet
    pool.update(10);
    expect(pool.activeCount).toBe(0);
    expect(pool.settledCount).toBe(2);
  });

  it('the pool is bounded — recycles handles under pressure (no unbounded growth)', () => {
    const pool = new DetachedPartPool({ capacity: 2, settleTicks: 100 });
    pool.detach(1 as unknown as EntityId, 'armLeft', 0, 0, 0, 0);
    pool.detach(2 as unknown as EntityId, 'armRight', 0, 0, 0, 1);
    pool.detach(3 as unknown as EntityId, 'legLeft', 0, 0, 0, 2); // forces recycle
    expect(pool.liveCount).toBeLessThanOrEqual(2);
  });
});
