// T74 — ammo, reload and weapon switching layered on the T73 per-weapon ballistics (V50).
// Reload/swap timers run on the self-tracked tick (no nowTick dep), advanced via combat.tick(dtTicks),
// so every deadline is deterministic under the fixed clock.
import { describe, it, expect } from 'vitest';
import { CombatSystem, type CombatDeps } from '@/game/combat';
import { SimulationZombies, SimTier, type ZombieSlot } from '@/game/simulation';
import { SpatialHash, CollisionLayer, layerMask } from '@/game/navigation/collision';
import { resolveDomain } from '@/config/registry';
import { weaponsConfig } from '@/config/domains/weapons';
import { combatConfig } from '@/config/domains/combat';
import type { ResolvedDomain } from '@/config/types';
import type { EntityId, EventId, VisualEvent, WorldEvent } from '@/game/core/contracts';

const AGENT_LAYERS = layerMask(CollisionLayer.Movement, CollisionLayer.Projectile, CollisionLayer.Attack);

function harness(weaponOverrides: Partial<ResolvedDomain<typeof weaponsConfig>> = {}) {
  const zombies = new SimulationZombies(64);
  const spatial = new SpatialHash({ cellSize: 2 });
  // Default these ammo tests to MANUAL reload (the dry-click / explicit-reload paths under test); the
  // auto-reload case opts in via overrides. The product default is now ON (see weaponsConfig).
  const weapons = { ...resolveDomain(weaponsConfig, 'desktop-high'), autoReloadWhenEmpty: false, ...weaponOverrides };
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

describe('T74 firearm ammo — magazine consumption', () => {
  it('each shot spends exactly one round and exposes the live ammo state', () => {
    const h = harness(); // pistol equipped
    spawn(h, 5, 0);
    const cap = h.weapons.pistolMagazineSize;
    expect(h.sys.currentAmmo()).toEqual({ magazine: cap, reserve: h.weapons.pistolReserveAmmo, reloading: false });

    const shot = h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    expect(shot.firedRounds).toBe(1);
    expect(shot.hit).toBe(true);
    expect(h.sys.currentAmmo().magazine).toBe(cap - 1);
  });

  it('an empty magazine is a dry click — no damage, firedRounds 0, empty flag set', () => {
    const h = harness();
    const target = spawn(h, 5, 0);
    const cap = h.weapons.pistolMagazineSize;
    for (let i = 0; i < cap; i++) h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    expect(h.sys.currentAmmo().magazine).toBe(0);

    const before = h.zombies.getHealth(target);
    const dry = h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    expect(dry.hit).toBe(false);
    expect(dry.empty).toBe(true);
    expect(dry.firedRounds).toBe(0);
    expect(h.zombies.getHealth(target)).toBe(before); // no damage on a dry click
  });

  it('melee is unlimited — it never depletes and reports Infinity ammo', () => {
    const h = harness();
    h.sys.setWeapon('melee');
    expect(h.sys.currentAmmo()).toEqual({
      magazine: Number.POSITIVE_INFINITY,
      reserve: Number.POSITIVE_INFINITY,
      reloading: false,
    });
    spawn(h, 1, 0);
    for (let i = 0; i < 50; i++) {
      expect(h.sys.fire(ORIGIN, 1, 0, 'torsoUpper').firedRounds).toBe(1);
    }
    expect(h.sys.reload()).toBe(false); // nothing to reload
  });
});

describe('T74 reload — refills from reserve after the duration, blocks fire meanwhile', () => {
  it('reload moves rounds reserve->magazine only after reloadTicks, and blocks fire while in flight', () => {
    const h = harness();
    const target = spawn(h, 5, 0);
    const cap = h.weapons.pistolMagazineSize;
    const reload = h.weapons.pistolReloadTicks;

    // empty the magazine
    for (let i = 0; i < cap; i++) h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    const reserveBefore = h.sys.currentAmmo().reserve;

    expect(h.sys.reload()).toBe(true);
    expect(h.sys.isReloading()).toBe(true);

    // mid-reload: fire is blocked, no damage, magazine still empty
    h.sys.tick(reload - 1);
    const before = h.zombies.getHealth(target);
    const blocked = h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    expect(blocked.firedRounds).toBe(0);
    expect(blocked.hit).toBe(false);
    expect(h.zombies.getHealth(target)).toBe(before);
    expect(h.sys.currentAmmo().magazine).toBe(0);

    // the tick the reload settles: magazine refilled from reserve, fire resolves again
    h.sys.tick(1);
    expect(h.sys.isReloading()).toBe(false);
    expect(h.sys.currentAmmo().magazine).toBe(cap);
    expect(h.sys.currentAmmo().reserve).toBe(reserveBefore - cap);
    expect(h.sys.fire(ORIGIN, 1, 0, 'torsoUpper').firedRounds).toBe(1);
  });

  it('reload on a full magazine is a no-op (returns false, reserve untouched)', () => {
    const h = harness();
    const reserve = h.sys.currentAmmo().reserve;
    expect(h.sys.reload()).toBe(false);
    expect(h.sys.currentAmmo().reserve).toBe(reserve);
  });

  it('out of reserve cannot reload (no silent top-up)', () => {
    const cap = resolveDomain(weaponsConfig, 'desktop-high').pistolMagazineSize;
    // shrink the pistol reserve to exactly one magazine so it empties cleanly
    const h = harness({ pistolReserveAmmo: cap });
    spawn(h, 5, 0);
    const reload = h.weapons.pistolReloadTicks;

    // empty mag, reload once (drains the whole reserve), empty mag again
    for (let i = 0; i < cap; i++) h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    expect(h.sys.reload()).toBe(true);
    h.sys.tick(reload);
    expect(h.sys.currentAmmo().reserve).toBe(0);
    for (let i = 0; i < cap; i++) h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');

    // now empty mag + empty reserve → cannot reload
    expect(h.sys.currentAmmo().magazine).toBe(0);
    expect(h.sys.reload()).toBe(false);
  });

  it('auto-reload-when-empty kicks a reload when firing an empty magazine', () => {
    const h = harness({ autoReloadWhenEmpty: true });
    spawn(h, 5, 0);
    const cap = h.weapons.pistolMagazineSize;
    const reload = h.weapons.pistolReloadTicks;
    for (let i = 0; i < cap; i++) h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');

    const dry = h.sys.fire(ORIGIN, 1, 0, 'torsoUpper'); // empty → auto-reload begins
    expect(dry.empty).toBe(true);
    expect(h.sys.isReloading()).toBe(true);
    h.sys.tick(reload);
    expect(h.sys.currentAmmo().magazine).toBe(cap);
  });
});

describe('T74 weapon switching — cycle changes the weapon and the swap delay blocks fire', () => {
  it('cycleWeapon advances the equipped class and gates fire until the swap settles', () => {
    const h = harness();
    expect(h.sys.currentWeaponId()).toBe('pistol');
    spawn(h, 5, 0);

    const next = h.sys.cycleWeapon(1);
    expect(next).toBe('rifle');
    expect(h.sys.currentWeaponId()).toBe('rifle');

    const swap = h.weapons.rifleSwapTicks;
    // mid-swap: fire blocked
    h.sys.tick(swap - 1);
    expect(h.sys.fire(ORIGIN, 1, 0, 'torsoUpper').firedRounds).toBe(0);
    // swap settles → fire resolves
    h.sys.tick(1);
    expect(h.sys.fire(ORIGIN, 1, 0, 'torsoUpper').firedRounds).toBe(1);
  });

  it('cycleWeapon -1 wraps backward around the registry order', () => {
    const h = harness();
    expect(h.sys.cycleWeapon(-1)).toBe('melee'); // pistol -> (wrap) melee
  });
});

describe('T74 shotgun spends ONE shell for its whole pellet pattern', () => {
  it('a single fire consumes one shell yet resolves the multi-pellet spread', () => {
    const h = harness();
    h.sys.setWeapon('shotgun');
    const a = spawn(h, 10, 1.2);
    const b = spawn(h, 10, -1.2);
    const cap = h.weapons.shotgunMagazineSize;

    const shot = h.sys.fire(ORIGIN, 1, 0, 'torsoUpper');
    expect(shot.firedRounds).toBe(1); // one SHELL
    expect(h.sys.currentAmmo().magazine).toBe(cap - 1);
    // the pellet cone still struck both off-axis bodies
    expect(h.zombies.getHealth(a)).toBeLessThan(1_000_000);
    expect(h.zombies.getHealth(b)).toBeLessThan(1_000_000);
  });
});

describe('refire cooldown (fire rate)', () => {
  it('the shotgun cannot fire again until its fire-interval elapses (pump cadence == sample length)', () => {
    const h = harness();
    spawn(h, 5, 0);
    h.sys.setWeapon('shotgun');
    const interval = h.weapons.shotgunFireIntervalTicks;
    expect(interval).toBeGreaterThan(0);

    expect(h.sys.fire(ORIGIN, 1, 0, 'torsoUpper').firedRounds).toBe(1);
    const magAfter = h.sys.currentAmmo().magazine;

    // immediate re-fire is blocked while pumping — no round fired, no shell consumed.
    expect(h.sys.fire(ORIGIN, 1, 0, 'torsoUpper').firedRounds).toBe(0);
    expect(h.sys.currentAmmo().magazine).toBe(magAfter);

    // one tick short still blocked; at the interval it fires again.
    h.sys.tick(interval - 1);
    expect(h.sys.fire(ORIGIN, 1, 0, 'torsoUpper').firedRounds).toBe(0);
    h.sys.tick(1);
    expect(h.sys.fire(ORIGIN, 1, 0, 'torsoUpper').firedRounds).toBe(1);
  });

  it('the pistol has no refire cooldown — fires every click', () => {
    const h = harness();
    spawn(h, 5, 0);
    expect(h.weapons.pistolFireIntervalTicks).toBe(0);
    expect(h.sys.fire(ORIGIN, 1, 0, 'torsoUpper').firedRounds).toBe(1);
    expect(h.sys.fire(ORIGIN, 1, 0, 'torsoUpper').firedRounds).toBe(1); // back-to-back, no gate
  });
});
