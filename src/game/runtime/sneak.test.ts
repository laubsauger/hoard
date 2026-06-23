// SNEAK stance on the GameRuntime (V62): Ctrl held emits LESS footstep noise than walking the same distance,
// so the horde — which only ever learns of the player through stimuli (V14) — is less likely to hear a sneaker.
// Stance noise order is sneak < walk < sprint. The footstep stimulus is a real, deterministic sim event driven
// by movement intent (V26 replay-safe).

import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildCityBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';

const TIER = 'desktop-high' as const;

function makeRuntime() {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildCityBlock() });
}

/** Walk the player `steps`×`dt` along -z with the given stance, then return the loudest emitted footstep
 *  stimulus intensity (the raw stored loudness, independent of distance falloff), or 0 if none were emitted. */
function loudestFootstep(rt: GameRuntime, sprint: boolean, sneak: boolean): number {
  const dt = 0.1;
  for (let i = 0; i < 20; i++) rt.movePlayer(0, -1, dt, sprint, sneak);
  const p = rt.player();
  const hits = rt.stimulus.query(p.x, p.z, rt.tick).filter((h) => h.stimulus.source === 'footstep');
  return hits.reduce((max, h) => Math.max(max, h.stimulus.intensity), 0);
}

describe('runtime sneak stance footstep noise (V62)', () => {
  it('emits a footstep stimulus while walking (the horde can hear the player move)', () => {
    const walk = makeRuntime();
    expect(loudestFootstep(walk, false, false)).toBeGreaterThan(0);
  });

  it('sneaking emits STRICTLY LESS footstep noise than walking the same distance', () => {
    const walked = loudestFootstep(makeRuntime(), false, false);
    const sneaked = loudestFootstep(makeRuntime(), false, true);
    expect(sneaked).toBeGreaterThan(0); // still audible, just quieter
    expect(sneaked).toBeLessThan(walked); // the core acceptance criterion (req 5)
  });

  it('orders stance loudness sneak < walk < sprint', () => {
    const sneaked = loudestFootstep(makeRuntime(), false, true);
    const walked = loudestFootstep(makeRuntime(), false, false);
    const sprinted = loudestFootstep(makeRuntime(), true, false);
    expect(sneaked).toBeLessThan(walked);
    expect(walked).toBeLessThan(sprinted);
  });
});
