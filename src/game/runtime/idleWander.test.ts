// T137 — idle wander: a target-less zombie ambles in a slow, deterministic, per-slot-phased direction that
// refreshes periodically (some intervals it pauses), so a crowd that lost its target disperses naturally.
import { describe, it, expect } from 'vitest';
import { idleWanderDir } from './hordeSystems';

const REFRESH = 90;

describe('idleWanderDir (T137)', () => {
  it('is deterministic — same (slot, tick) → same result (replay-stable, V26)', () => {
    const a = idleWanderDir(7, 1234, REFRESH, 0.45);
    const b = idleWanderDir(7, 1234, REFRESH, 0.45);
    expect(a).toEqual(b);
  });

  it('returns a UNIT direction when moving', () => {
    for (let slot = 0; slot < 50; slot++) {
      const w = idleWanderDir(slot, 0, REFRESH, 0); // pauseChance 0 → always moves
      expect(Math.hypot(w.dirX, w.dirZ)).toBeCloseTo(1, 6);
    }
  });

  it('pauseChance 1 → always stands; pauseChance 0 → always ambles', () => {
    expect(idleWanderDir(3, 10, REFRESH, 1).moving).toBe(false);
    expect(idleWanderDir(3, 10, REFRESH, 0).moving).toBe(true);
  });

  it('holds one direction across a refresh window, then re-rolls', () => {
    const slot = 11;
    // find a tick where this slot is moving, then check the direction is stable until its window ends.
    const at = (t: number) => idleWanderDir(slot, t, REFRESH, 0);
    const d0 = at(1000);
    let sameForAWhile = true;
    for (let t = 1000; t < 1000 + 5; t++) {
      const d = at(t);
      if (d.dirX !== d0.dirX || d.dirZ !== d0.dirZ) sameForAWhile = false;
    }
    expect(sameForAWhile).toBe(true); // stable within the window (consecutive ticks share a bucket)
    // far enough ahead (> a full refresh) the direction almost certainly differs.
    let changedEventually = false;
    for (let t = 1000; t < 1000 + REFRESH * 3; t++) {
      const d = at(t);
      if (d.dirX !== d0.dirX || d.dirZ !== d0.dirZ) {
        changedEventually = true;
        break;
      }
    }
    expect(changedEventually).toBe(true);
  });

  it('different slots wander in different directions (dispersion, not lockstep)', () => {
    const dirs = new Set<string>();
    for (let slot = 0; slot < 30; slot++) {
      const w = idleWanderDir(slot, 0, REFRESH, 0);
      dirs.add(`${w.dirX.toFixed(3)},${w.dirZ.toFixed(3)}`);
    }
    expect(dirs.size).toBeGreaterThan(20); // mostly distinct headings across the crowd
  });
});
