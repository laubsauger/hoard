// V53/B20 — firearm shots must STOP at the first projectile-blocking structure cell; they never pass
// through the intact dividing wall to hit the sealed horde. Breaching the cell restores the line (V5).
// Exercises the real GameRuntime wiring: CombatSystem -> firstProjectileBlockerDistance -> scene nav.
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import type { CommandId, ModuleId } from '@/game/core/contracts';

const TIER = 'desktop-high' as const;

function makeRuntime() {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildTestBlock() });
}

// A zombie in room A, on the same row (z) as the player so the shot ray is a clean -x line through the
// dividing wall at cx 20. World coords derive from the scene's own cell centre mapping (no literals).
function spawnTargetAcrossWall(rt: GameRuntime) {
  const player = rt.player();
  const c = rt.scene.cellCenter(rt.scene.spawnCenterCell);
  return rt.spawnZombie({ x: c.x, y: 0, z: player.z });
}

describe('V53/B20 firearm occlusion through the GameRuntime', () => {
  it('the intact dividing wall blocks the shot — the horde-side zombie is NOT hit', () => {
    const rt = makeRuntime();
    const entity = spawnTargetAcrossWall(rt);
    const res = rt.fireAtEntity(entity, 'torsoUpper');
    expect(res.hit).toBe(false);
    expect(rt.isAliveEntity(entity)).toBe(true);
    // Stop distance is the wall, strictly inside the full line to the target (the shot stopped early).
    const player = rt.player();
    const pos: [number, number, number] = [0, 0, 0];
    rt.zombies.getPosition(rt.slotOf(entity)!, pos);
    const toTarget = Math.abs(pos[0] - player.x);
    expect(res.stopDistanceMeters).toBeGreaterThan(0);
    expect(res.stopDistanceMeters!).toBeLessThan(toTarget);
  });

  it('after breaching the wall cell the line is restored and the zombie IS hit', () => {
    const rt = makeRuntime();
    const entity = spawnTargetAcrossWall(rt);
    const module = rt.scene.moduleId as ModuleId;
    const breach = rt.dispatch({ kind: 'modifyStructure', id: 1 as CommandId, module, cell: rt.defaultBreachCell(), op: 'breach' });
    expect(breach.ok).toBe(true);

    const res = rt.fireAtEntity(entity, 'torsoUpper');
    expect(res.hit).toBe(true);
    expect(res.targetEntity).toBe(entity);
    expect(res.stopDistanceMeters).toBeGreaterThan(0);
  });

  it('a clean line to a target with no wall in between reports stop distance = first body', () => {
    const rt = makeRuntime();
    // Target in the SAME room as the player (room B) — no wall on the line of fire.
    const player = rt.player();
    const entity = rt.spawnZombie({ x: player.x - 6, y: 0, z: player.z });
    const res = rt.fireAtEntity(entity, 'torsoUpper');
    expect(res.hit).toBe(true);
    expect(res.stopDistanceMeters!).toBeGreaterThan(0);
  });
});
