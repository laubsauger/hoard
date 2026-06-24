// V14 investigate persistence — a zombie that LOSES the stimulus that startled it does NOT freeze on the
// spot: it keeps moving to the LAST-KNOWN stimulus origin for `perception.investigateTicks` before giving up
// to idle. The chosen target CELL is held (decaying over the investigate window), so a one-shot disturbance
// (a door clatter, a footstep) pulls the body all the way to where the noise came from, then it idles.
//
// Repro of the reported feedback: player opens a door → a zombie starts coming → player closes the door →
// the stimulus is gone. The body must CONTINUE toward the last-known origin, not stop where it stood.

import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import type { Stimulus, StimulusId } from '@/game/core/contracts';

const TIER = 'desktop-high' as const;
const TICK_DT = 1 / 30;

function makeRuntime() {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildTestBlock() });
}

function navCellOf(rt: GameRuntime, x: number, z: number): number {
  const c = rt.scene.navGrid.worldToCell(x, z);
  return rt.scene.navGrid.index(c.cx, c.cy);
}

/** A one-shot sound that decays over a handful of ticks — long enough to be heard at the first perception
 *  tick, then gone, so the rest of the run exercises the post-stimulus investigate behaviour. */
function emitFadingSound(rt: GameRuntime, x: number, z: number): void {
  const stim: Stimulus = {
    id: 1 as StimulusId,
    kind: 'sound',
    source: 'gunfire',
    x,
    z,
    intensity: 0.9,
    radius: 30,
    bornTick: rt.tick,
    decayPerTick: 0.08, // ~10 ticks of audibility above the alert threshold, then silent
  };
  rt.stimulus.emit(stim, rt.tick);
}

describe('investigate persistence after a lost stimulus (V14)', () => {
  it('keeps moving to the last-known origin once the stimulus fades, then idles', () => {
    const rt = makeRuntime();
    // Spawn in room A; the player sits in room B behind the dividing wall, so there is NEVER line-of-sight —
    // the only thing that can target the zombie is the sound, isolating the investigate behaviour.
    const a = rt.scene.cellCenter(rt.scene.spawnCenterCell);
    const z = rt.spawnZombie({ x: a.x, y: 0, z: a.z });
    const slot = rt.slotOf(z)!;
    const originX = a.x - 8;
    const originZ = a.z;
    const originCell = navCellOf(rt, originX, originZ);
    emitFadingSound(rt, originX, originZ);

    // Acquire: by the first perception tick the zombie has heard the sound and targets its cell.
    for (let i = 0; i < 6; i++) rt.update(TICK_DT);
    expect(rt.zombieTargetCell(z)).toBe(originCell);
    const acq = rt.zombies.getPosition(slot).slice();
    const distAcq = Math.hypot(acq[0]! - originX, acq[2]! - originZ);

    // The sound is now long gone. The body must still hold the origin as its target AND make progress
    // toward it — it investigates, it does NOT freeze where it stood.
    for (let i = 0; i < 40; i++) rt.update(TICK_DT);
    expect(rt.zombieTargetCell(z)).toBe(originCell); // still investigating the remembered origin
    const mid = rt.zombies.getPosition(slot).slice();
    const distMid = Math.hypot(mid[0]! - originX, mid[2]! - originZ);
    expect(distMid).toBeLessThan(distAcq - 0.5); // measurably CLOSER to the origin (moved, not frozen)

    // After the investigate window lapses, with nothing sensed, it gives up → idle (no target).
    for (let i = 0; i < 160; i++) rt.update(TICK_DT);
    expect(rt.zombieTargetCell(z)).toBe(-1);
  });
});
