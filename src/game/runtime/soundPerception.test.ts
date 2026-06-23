// V14/V15 — localized, per-zombie, stimulus-driven target selection + grouped multi-field movement.
//
// Sound is LOCALIZED perception, not a global flow retarget. Each zombie picks ITS OWN target every
// perception tick: the player if it sees it, else the loudest sound it hears, else idle. Zombies that
// chose the same target cell share one flow field; sources in different regions pull groups in different
// directions. These tests prove each rule the redesign requires (and that the old global lure is gone).

import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import type { EntityId, Stimulus, StimulusId } from '@/game/core/contracts';

const TIER = 'desktop-high' as const;
const TICK_DT = 1 / 30;

function makeRuntime() {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildTestBlock() });
}

function navCellOf(rt: GameRuntime, x: number, z: number): number {
  const c = rt.scene.navGrid.worldToCell(x, z);
  return rt.scene.navGrid.index(c.cx, c.cy);
}

/**
 * Emit a controlled, non-decaying sound stimulus directly into the shared field (deterministic test input):
 * a fixed origin/intensity/radius that stays audible across the run so perception sampling is stable.
 */
let nextStimId = 1;
function emitSound(rt: GameRuntime, x: number, z: number, intensity: number, radius: number): void {
  const stim: Stimulus = {
    id: nextStimId++ as StimulusId,
    kind: 'sound',
    source: 'gunfire',
    x,
    z,
    intensity,
    radius,
    bornTick: rt.tick,
    decayPerTick: 0, // never decays — a steady source for the duration of the test
  };
  rt.stimulus.emit(stim, rt.tick);
}

function velocityOf(rt: GameRuntime, entity: EntityId): [number, number, number] {
  const slot = rt.slotOf(entity)!;
  return rt.zombies.getVelocity(slot);
}

describe('per-zombie target selection (V14)', () => {
  it('a zombie that SEES the player targets the player cell', () => {
    const rt = makeRuntime();
    const p = rt.player();
    const z = rt.spawnZombie({ x: p.x, y: 0, z: p.z }); // on the player → in sight, clear LOS
    for (let i = 0; i < 6; i++) rt.update(TICK_DT);
    expect(rt.zombieTargetCell(z)).toBe(navCellOf(rt, p.x, p.z));
  });

  it('a zombie that only HEARS a sound targets that sound\'s cell', () => {
    const rt = makeRuntime();
    // Spawn in room A; the player sits in room B behind the dividing wall, so there is never line-of-sight.
    const a = rt.scene.cellCenter(rt.scene.spawnCenterCell);
    const z = rt.spawnZombie({ x: a.x, y: 0, z: a.z });
    // A sound a few metres away inside room A (well within hearing, clear LOS, above the alert threshold).
    const soundX = a.x - 6;
    emitSound(rt, soundX, a.z, 0.8, 30);
    for (let i = 0; i < 6; i++) rt.update(TICK_DT); // run past the first perception tick (every 4 ticks)
    expect(rt.zombieTargetCell(z)).toBe(navCellOf(rt, soundX, a.z));
  });

  it('with two sounds reaching one zombie, the LOUDER-reaching one wins', () => {
    const rt = makeRuntime();
    const a = rt.scene.cellCenter(rt.scene.spawnCenterCell);
    const z = rt.spawnZombie({ x: a.x, y: 0, z: a.z });
    // Two overlapping sources both reach the zombie; the nearer/stronger one attenuates to a higher
    // intensity at the zombie's position and must win.
    const loudX = a.x - 4; // close → loud
    const quietX = a.x + 12; // far → quiet
    emitSound(rt, loudX, a.z, 0.9, 40);
    emitSound(rt, quietX, a.z, 0.9, 40);
    for (let i = 0; i < 6; i++) rt.update(TICK_DT);
    expect(rt.zombieTargetCell(z)).toBe(navCellOf(rt, loudX, a.z));
  });

  it('a zombie OUTSIDE a localized sound\'s radius is NOT retargeted (no global lure)', () => {
    const rt = makeRuntime();
    const a = rt.scene.cellCenter(rt.scene.spawnCenterCell);
    const near = rt.spawnZombie({ x: a.x, y: 0, z: a.z });
    const far = rt.spawnZombie({ x: a.x + 16, y: 0, z: a.z }); // 16 m east of the source
    // A small-radius sound (5 m) at the spawn centre: only the co-located zombie can hear it.
    emitSound(rt, a.x, a.z, 0.9, 5);
    for (let i = 0; i < 6; i++) rt.update(TICK_DT);
    expect(rt.zombieTargetCell(near)).toBe(navCellOf(rt, a.x, a.z)); // heard it → retargeted
    expect(rt.zombieTargetCell(far)).toBe(-1); // out of range → never heard it → stays idle (no target)
  });
});

describe('grouped multi-field movement steers regions independently (V15)', () => {
  it('two sources in different areas pull two zombie groups in DIFFERENT directions', () => {
    const rt = makeRuntime();
    const a = rt.scene.cellCenter(rt.scene.spawnCenterCell); // room A centre
    // West group + a source further WEST of it; east group + a source further EAST of it.
    const westZ = rt.spawnZombie({ x: a.x - 8, y: 0, z: a.z });
    const eastZ = rt.spawnZombie({ x: a.x + 8, y: 0, z: a.z });
    const westSource = a.x - 16;
    const eastSource = a.x + 16;
    // Re-emit each steady source every tick so both stay audible while perception (every 4 ticks) samples.
    for (let i = 0; i < 12; i++) {
      emitSound(rt, westSource, a.z, 0.9, 30);
      emitSound(rt, eastSource, a.z, 0.9, 30);
      rt.update(TICK_DT);
    }
    // Each group heard its nearer source loudest → chose a different target cell → followed a different field.
    expect(rt.zombieTargetCell(westZ)).toBe(navCellOf(rt, westSource, a.z));
    expect(rt.zombieTargetCell(eastZ)).toBe(navCellOf(rt, eastSource, a.z));
    // ...and steered in opposite x directions (west group moves -x, east group moves +x).
    const vWest = velocityOf(rt, westZ);
    const vEast = velocityOf(rt, eastZ);
    expect(vWest[0]).toBeLessThan(0);
    expect(vEast[0]).toBeGreaterThan(0);
  });
});
