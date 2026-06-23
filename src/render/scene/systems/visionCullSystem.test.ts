// VisionCullSystem: the per-slot reveal buffer is sized to the SoA capacity (no per-frame alloc, V24), and a
// zombie that leaves view DECAYS through the recently-seen memory rather than snapping to 0 (V62). Pure CPU —
// a fake runtime with a trivially-walkable scene (clear structural LOS) so near-awareness reveal fires.

import { describe, it, expect } from 'vitest';
import { VisionCullSystem, type VisionCullSystemConfig } from './visionCullSystem';
import type { GameRuntime } from '../../../game/runtime';

const CFG: VisionCullSystemConfig = {
  playerFieldOfViewDegrees: 90,
  playerVisionRange: 20,
  playerVisionRangeFadeMeters: 2,
  playerVisionConeFadeDegrees: 5,
  playerNearAwarenessRadiusMeters: 4,
  hearingRange: 10,
  soundWallOcclusion: 0.5,
  playerSightMemorySeconds: 1,
};

const CAPACITY = 16;

function fakeRuntime(): { runtime: GameRuntime; alive: Uint8Array; position: Float32Array } {
  const position = new Float32Array(CAPACITY * 3);
  const alive = new Uint8Array(CAPACITY);
  const state = new Uint8Array(CAPACITY);
  const runtime = {
    player: () => ({ x: 0, y: 0, z: 0 }),
    playerAim: () => 0,
    scene: { isWalkableWorld: () => true }, // clear structural LOS everywhere
    zombies: { capacity: CAPACITY, count: 1, views: { position, alive, state } },
  } as unknown as GameRuntime;
  return { runtime, alive, position };
}

describe('VisionCullSystem', () => {
  it('sizes the reveal buffer to the SoA capacity', () => {
    const { runtime } = fakeRuntime();
    const sys = new VisionCullSystem(CAPACITY, CFG);
    const cull = sys.build(runtime, 1 / 60);
    expect(cull.reveal).toBeDefined();
    expect(cull.reveal!.length).toBe(CAPACITY);
  });

  it('decays a once-seen zombie toward 0 over the memory window instead of snapping', () => {
    const { runtime, alive } = fakeRuntime();
    const sys = new VisionCullSystem(CAPACITY, CFG);

    // Slot 0 sits ON the player (dist 0 <= nearRadius) with clear LOS → fully revealed this frame.
    alive[0] = 1;
    let cull = sys.build(runtime, 0);
    expect(cull.reveal![0]).toBeCloseTo(1, 5);

    // It dies / leaves view → instantaneous reveal drops to 0, but memory decays it gradually (memorySeconds=1).
    alive[0] = 0;
    cull = sys.build(runtime, 0.25);
    const afterQuarter = cull.reveal![0]!;
    expect(afterQuarter).toBeGreaterThan(0);
    expect(afterQuarter).toBeLessThan(1); // decaying, not snapped to 0

    cull = sys.build(runtime, 0.5);
    expect(cull.reveal![0]!).toBeLessThan(afterQuarter); // monotonic decay

    // Past the memory window the reveal reaches 0.
    cull = sys.build(runtime, 1);
    expect(cull.reveal![0]!).toBe(0);
  });
});
