// T54 / B9 (SPEC §V V18) — death TRANSITION on the GameRuntime: a killed zombie does NOT pop out of
// existence. The death frees the sim slot BUT first leaves a persistent corpse record (last transform +
// archetype + severed-region flags), which survives a save/reload through the §I corpses save-delta (V9).

import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildCityBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import type { EntityId } from '@/game/core/contracts';

const TIER = 'desktop-high' as const;

function makeRuntime(adapter = new InMemoryPersistenceAdapter()) {
  return new GameRuntime({ tier: TIER, adapter, scene: buildCityBlock() });
}

/** Spawn a zombie one cell west of the player (open line of fire) and return its EntityId. */
function spawnAdjacent(rt: GameRuntime): EntityId {
  const c = rt.scene.cellCenter({ cx: rt.scene.playerCell.cx - 1, cy: rt.scene.playerCell.cy });
  return rt.spawnZombie({ x: c.x, y: 0, z: c.z });
}

/** Fire torso shots at a live entity until it dies (bounded so a miss can never hang the test). */
function killByFire(rt: GameRuntime, e: EntityId): void {
  for (let i = 0; i < 200 && rt.isAliveEntity(e); i++) {
    rt.fireAtEntity(e, 'torsoUpper');
  }
}

describe('B9/T54 death -> corpse transition', () => {
  it('leaves a corpse record (not an instant vanish) when a zombie dies', () => {
    const rt = makeRuntime();
    const e = spawnAdjacent(rt);
    expect(rt.aliveCount).toBe(1);
    expect(rt.corpses.count).toBe(0);

    killByFire(rt, e);

    expect(rt.isAliveEntity(e)).toBe(false); // sim slot freed
    expect(rt.aliveCount).toBe(0);
    expect(rt.corpses.count).toBe(1); // ...but a corpse lingers
    expect(rt.corpses.list[0]!.entity).toBe(e as number);
  });

  it('carries the dismemberment (severed-region flags) onto the corpse', () => {
    const rt = makeRuntime();
    const e = spawnAdjacent(rt);
    const slot = rt.slotOf(e)!;
    // Pre-set a severed arm + leg on the live zombie (the dismemberment consequence we expect to persist).
    const severed = (1 << 5) | (1 << 6); // armRight | legLeft (see combat/anatomy bit layout)
    rt.zombies.setAnatomyFlags(slot, severed);

    killByFire(rt, e);

    expect(rt.corpses.count).toBe(1);
    // The kill may add its own fatal-region sever bit; the pre-existing dismemberment must still be present.
    expect(rt.corpses.list[0]!.severedFlags & severed).toBe(severed);
  });

  it('bodyAnchor reports upright while alive, toppled after death, null when gone (Bug A render anchor)', () => {
    const rt = makeRuntime();
    const e = spawnAdjacent(rt);
    const slot = rt.slotOf(e)!;
    const pos: [number, number, number] = [0, 0, 0];
    rt.zombies.getPosition(slot, pos);

    const live = rt.bodyAnchor(e)!;
    expect(live).not.toBeNull();
    expect(live.lying).toBe(0); // upright while alive
    expect(live.x).toBeCloseTo(pos[0], 4);
    expect(live.z).toBeCloseTo(pos[2], 4);

    killByFire(rt, e);

    const dead = rt.bodyAnchor(e)!;
    expect(dead).not.toBeNull();
    expect(dead.lying).toBe(1); // toppled flat onto the corpse
    expect(dead.x).toBeCloseTo(pos[0], 4);
    expect(dead.z).toBeCloseTo(pos[2], 4);

    expect(rt.bodyAnchor(999999 as unknown as EntityId)).toBeNull(); // never-existed body → gore fades
  });

  it('captures the corpse at the body\'s last position', () => {
    const rt = makeRuntime();
    const e = spawnAdjacent(rt);
    const slot = rt.slotOf(e)!;
    const pos: [number, number, number] = [0, 0, 0];
    rt.zombies.getPosition(slot, pos);

    killByFire(rt, e);

    const c = rt.corpses.list[0]!;
    expect(c.x).toBeCloseTo(pos[0], 4);
    expect(c.z).toBeCloseTo(pos[2], 4);
  });

  it('a corpse past its configured lifetime is cleaned up by the prune step', () => {
    const rt = makeRuntime();
    const e = spawnAdjacent(rt);
    killByFire(rt, e);
    expect(rt.corpses.count).toBe(1);

    // Force-expire: prune at a tick well beyond the lifetime (the runtime registers a coarse prune step).
    rt.corpses.prune(rt.corpses.settings.lifetimeTicks + rt.corpses.list[0]!.bornTick + 1);
    expect(rt.corpses.count).toBe(0);
  });
});

describe('B9/T54 corpse persistence (V9 — corpses save-delta category)', () => {
  it('saves + reloads lingering corpses into a fresh runtime, with severed flags', async () => {
    const adapter = new InMemoryPersistenceAdapter();
    const rtA = makeRuntime(adapter);
    const e = spawnAdjacent(rtA);
    const slot = rtA.slotOf(e)!;
    const severed = 1 << 4; // armLeft
    rtA.zombies.setAnatomyFlags(slot, severed);
    killByFire(rtA, e);
    expect(rtA.corpses.count).toBe(1);
    const saved = { ...rtA.corpses.list[0]! };
    await rtA.save();

    const rtB = makeRuntime(adapter);
    await rtB.loadFrom();

    expect(rtB.corpses.count).toBe(1);
    const c = rtB.corpses.list[0]!;
    expect(c.entity).toBe(saved.entity);
    expect(c.x).toBeCloseTo(saved.x, 4);
    expect(c.z).toBeCloseTo(saved.z, 4);
    expect(c.severedFlags & severed).toBe(severed);
    expect(c.archetype).toBe(saved.archetype);
  });
});
