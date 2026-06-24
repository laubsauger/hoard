// T134/V101 — the user-reported case: a gunshot FROM INSIDE a (sealed) house must not leave the outside
// horde "walking on the spot, no idea where to go". A zombie that HEARS a sound whose source is SEALED behind
// walls (no nav path) can't follow a flow field there (the field never reaches it) — so it BEELINES toward the
// source world position to investigate the area, advancing toward it instead of freezing. Deterministic SIM
// (no rendering) over the GATE-0 test block, whose solid wall fully separates room A | room B until breached.

import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import type { Stimulus, StimulusId } from '@/game/core/contracts';

const TIER = 'desktop-high' as const;
const TICK_DT = 1 / 30;

function makeRuntime(): GameRuntime {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildTestBlock() });
}

let nextStimId = 1;
/** Emit a steady (non-decaying) loud gunshot at (x,z) — a stable source for the run. */
function emitSound(rt: GameRuntime, x: number, z: number): void {
  const stim: Stimulus = {
    id: nextStimId++ as StimulusId,
    kind: 'sound',
    source: 'gunfire',
    x,
    z,
    intensity: 1,
    radius: 80,
    bornTick: rt.tick,
    decayPerTick: 0,
  };
  rt.stimulus.emit(stim, rt.tick);
}

describe('zombie investigates a SEALED sound source (T134/V101)', () => {
  it('a zombie walled off from the source still ADVANCES toward it (beeline), not frozen on the spot', () => {
    const rt = makeRuntime();
    const p = rt.player(); // player stands in room B
    // Spawn a zombie 30 m to the -x of the player — in room A, on the FAR side of the (closed) dividing wall,
    // so the player's cell is genuinely UNREACHABLE by nav. This is the "fired from inside a sealed house" case.
    const ent = rt.spawnZombie({ x: p.x - 30, y: 0, z: p.z });
    const slot = rt.slotOf(ent)!;
    const pos0: [number, number, number] = [0, 0, 0];
    rt.zombies.getPosition(slot, pos0);

    // A steady loud gunshot at the player: the zombie HEARS it through the wall (V100) and targets the player's
    // (unreachable) cell. Re-emitted is unnecessary — it does not decay — but emit once up front.
    emitSound(rt, p.x, p.z);

    let maxSpeed = 0;
    for (let i = 0; i < 90; i++) {
      rt.update(TICK_DT);
      const v = rt.zombies.getVelocity(slot);
      maxSpeed = Math.max(maxSpeed, Math.hypot(v[0], v[2]));
    }
    const pos1: [number, number, number] = [0, 0, 0];
    rt.zombies.getPosition(slot, pos1);

    // it acquired the heard source as a target ...
    expect(rt.zombieTargetCell(ent)).toBeGreaterThanOrEqual(0);
    // ... it actually MOVED (non-zero velocity at some point) — not frozen "walking on the spot" ...
    expect(maxSpeed).toBeGreaterThan(0.1);
    // ... and net it ADVANCED toward the source (+x, toward the wall the source lies behind), closing distance.
    expect(pos1[0]).toBeGreaterThan(pos0[0] + 3);
  });
});
