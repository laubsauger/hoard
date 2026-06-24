// DoorSystem: a leaf eases toward its sim-driven open/closed target at the configured speed, and SNAPS at
// dt<=0 (the construction-time prime). Pure CPU — fakes the runtime door views + nav-grid indexing.

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { DoorSystem } from './doorSystem';
import type { GameRuntime } from '../../../game/runtime';
import type { DoorLeaf } from '../builders/handles';

function fakeRuntime(open: boolean): GameRuntime {
  return {
    doorViews: () => [{ cx: 0, cy: 0, x: 0, z: 0, access: open ? 'open' : 'closed' }],
    scene: { navGrid: { index: (cx: number, _cy: number) => cx, settings: { navCellSize: 1 } } },
  } as unknown as GameRuntime;
}

function makeLeaf(): DoorLeaf {
  return { navCell: 0, pivot: new Object3D(), openTarget: Math.PI / 2, current: 0 };
}

describe('DoorSystem', () => {
  it('eases the leaf toward the open target monotonically and never overshoots', () => {
    const leaf = makeLeaf();
    const sys = new DoorSystem([leaf], { swingSpeedRadiansPerSecond: 3 });
    const rt = fakeRuntime(true);
    let prev = leaf.current;
    for (let i = 0; i < 60; i++) {
      sys.sync(rt, 1 / 60);
      expect(leaf.current).toBeGreaterThanOrEqual(prev); // monotonic toward target
      expect(leaf.current).toBeLessThanOrEqual(leaf.openTarget + 1e-9); // no overshoot
      expect(leaf.pivot.rotation.y).toBe(leaf.current); // pivot reflects the eased angle
      prev = leaf.current;
    }
    expect(leaf.current).toBeGreaterThan(leaf.openTarget * 0.8); // converging on open
  });

  it('snaps instantly at dt<=0 (construction prime / rebind)', () => {
    const leaf = makeLeaf();
    const sys = new DoorSystem([leaf], { swingSpeedRadiansPerSecond: 3 });
    sys.sync(fakeRuntime(true), 0);
    expect(leaf.current).toBe(leaf.openTarget);
    expect(leaf.pivot.rotation.y).toBe(leaf.openTarget);

    sys.sync(fakeRuntime(false), 0);
    expect(leaf.current).toBe(0); // closed snaps back to the wall plane
  });
});
