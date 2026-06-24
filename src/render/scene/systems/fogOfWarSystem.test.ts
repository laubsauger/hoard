// T109 / V73 — FogOfWarSystem: the per-frame reveal sweep marks cells VISIBLE only inside the cone ∪ passive
// disc AND with clear structural LOS (a wall occludes the reveal, never a second wall representation); the
// VISITED memory persists so a cell that leaves view reads EXPLORED, not back to unexplored. Pure CPU — a fake
// runtime with a controllable walkable predicate. No GPU device needed (node material + DataTexture construct
// as plain objects; nothing uploads without a renderer).

import { describe, it, expect } from 'vitest';
import { FogOfWarSystem, type FogOfWarSystemConfig } from './fogOfWarSystem';
import { ResourceRegistry } from '../../engine/resources';
import type { GameRuntime } from '../../../game/runtime';

const CFG: FogOfWarSystemConfig = {
  cols: 10,
  rows: 10,
  cellSize: 2,
  worldWidth: 20,
  worldDepth: 20,
  cone: { fovDegrees: 360, range: 6, rangeFadeMeters: 0, coneFadeDegrees: 0 }, // omnidirectional, 6 m reach
  dims: { exploredDim: 0.5, unexploredDim: 0.85 },
  fadePerSecond: 6,
  heightMeters: 0.06,
  color: 0x05070a,
};

/** Fake runtime: mutable player pos + an injectable walkable predicate (clear LOS unless a wall is set). */
function fakeRuntime(walkable: (x: number, z: number) => boolean = () => true) {
  const pose = { x: 5, z: 5, aim: 0 };
  const runtime = {
    player: () => ({ x: pose.x, y: 0, z: pose.z }),
    playerAim: () => pose.aim,
    scene: { isWalkableWorld: walkable },
  } as unknown as GameRuntime;
  return { runtime, pose };
}

describe('FogOfWarSystem (V73)', () => {
  it('reveals the cone ∪ passive disc around the player and leaves distant cells unexplored', () => {
    const { runtime } = fakeRuntime();
    const sys = new FogOfWarSystem(new ResourceRegistry(), CFG);
    sys.update(runtime, 6, 100, true); // dt large → opacity snaps to its state target

    // Player at (5,5) → cell (2,2): in view → fully clear.
    expect(sys.debugStateAt(2, 2)).toBe('visible');
    expect(sys.debugAlphaAt(2, 2)).toBeCloseTo(0, 2);

    // (4,4) centre (9,9) is ~5.66 m away (< 6) → visible. (9,9) is far outside the swept box → never seen.
    expect(sys.debugStateAt(4, 4)).toBe('visible');
    expect(sys.debugStateAt(9, 9)).toBe('unexplored');
    expect(sys.debugAlphaAt(9, 9)).toBeCloseTo(CFG.dims.unexploredDim, 2);
  });

  it('a cell that leaves view becomes EXPLORED memory (not back to unexplored)', () => {
    const { runtime, pose } = fakeRuntime();
    const sys = new FogOfWarSystem(new ResourceRegistry(), CFG);
    sys.update(runtime, 6, 100, true);
    expect(sys.debugStateAt(2, 2)).toBe('visible');

    // Walk far away so (2,2) is no longer in view.
    pose.x = 15;
    pose.z = 15;
    sys.update(runtime, 6, 100, true);
    expect(sys.debugStateAt(2, 2)).toBe('explored'); // remembered, dimmed
    expect(sys.debugAlphaAt(2, 2)).toBeCloseTo(CFG.dims.exploredDim, 2);
    expect(sys.debugStateAt(7, 7)).toBe('visible'); // new position revealed
  });

  it('a wall occludes the reveal — a cell behind it within range is NOT revealed (structural LOS, V63)', () => {
    // Block the cell column cx=3 (world x in [6,8)). Player at (5,5) cannot see past it toward +x.
    const wall = (x: number, _z: number): boolean => !(x >= 6 && x < 8);
    const { runtime } = fakeRuntime(wall);
    const sys = new FogOfWarSystem(new ResourceRegistry(), CFG);
    sys.update(runtime, 6, 100, true);

    // (4,2) centre (9,5) is 4 m away (< 6) but the (6..8) wall blocks the line of sight → stays fogged.
    expect(sys.debugStateAt(4, 2)).not.toBe('visible');
    // (1,2) centre (3,5) is on the near side, clear LOS → visible.
    expect(sys.debugStateAt(1, 2)).toBe('visible');
  });

  it('opacity FADES toward its target rather than snapping (smooth transitions)', () => {
    const { runtime } = fakeRuntime();
    const sys = new FogOfWarSystem(new ResourceRegistry(), CFG);
    // Small dt: a far (unexplored) cell barely moves from its seeded unexplored opacity; a visible cell eases
    // toward 0 but does not reach it in one short step.
    sys.update(runtime, 6, 1 / 60, true);
    const a = sys.debugAlphaAt(2, 2); // player cell, target 0
    expect(a).toBeGreaterThan(0); // not snapped to 0
    expect(a).toBeLessThan(CFG.dims.unexploredDim); // but easing down from the unexplored seed
  });

  it('the master toggle hides/shows the overlay mesh', () => {
    const { runtime } = fakeRuntime();
    const sys = new FogOfWarSystem(new ResourceRegistry(), CFG);
    sys.update(runtime, 6, 1 / 60, false);
    expect(sys.mesh.visible).toBe(false);
    sys.update(runtime, 6, 1 / 60, true);
    expect(sys.mesh.visible).toBe(true);
  });
});
