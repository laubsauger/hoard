// T131 / V99 — PURE impact-directional death topple. A killed zombie tips over in the killing shot's push
// direction (front → onto its back, side → sideways, behind → onto its face); a force-less death crumples
// forward along its own heading ("straight down"). Deterministic (V26). No three / GPU — node-testable.

import { describe, it, expect } from 'vitest';
import {
  corpseTopple,
  toppleForceFactor,
  toppleEase,
  collapseProgress,
  collapseEase,
  CORPSE_PRONE_PITCH,
  CORPSE_LIE_HEIGHT,
} from './corpseTopple';

const COLLAPSE = 15; // collapse duration (ticks)
const SETTLED = 10_000; // an age far past collapse → fully prone

describe('corpseTopple (T131/V99) — impact-directional fall', () => {
  it('a SHOT from the front (bullet travelling +X) topples the body toward +X (onto its back)', () => {
    const t = corpseTopple(1, 0, 40, SETTLED, COLLAPSE, /*heading*/ 2.5);
    expect(t.fallYaw).toBeCloseTo(0, 6); // atan2(0, +1) = 0 — falls along the bullet, independent of heading
    expect(t.pitch).toBeCloseTo(CORPSE_PRONE_PITCH, 6); // fully prone once settled
  });

  it('a SIDE shot (bullet travelling +Z) topples the body SIDEWAYS toward +Z', () => {
    const t = corpseTopple(0, 1, 40, SETTLED, COLLAPSE, 0);
    expect(t.fallYaw).toBeCloseTo(Math.PI / 2, 6);
  });

  it('a shot from BEHIND (bullet travelling -X) topples the body toward -X (onto its face)', () => {
    const t = corpseTopple(-1, 0, 40, SETTLED, COLLAPSE, 0);
    expect(Math.abs(t.fallYaw)).toBeCloseTo(Math.PI, 6); // atan2(0,-1) = ±π
  });

  it('the impact direction DOMINATES the heading for a forceful hit (not heading-aligned)', () => {
    // Body facing one way (heading=0) but shot from +Z → it must fall toward +Z, not toward heading 0.
    const t = corpseTopple(0, 1, 40, SETTLED, COLLAPSE, 0);
    expect(t.fallYaw).not.toBeCloseTo(0, 2);
    expect(t.fallYaw).toBeCloseTo(Math.PI / 2, 6);
  });

  it('a ZERO-force death (melee / expiry) falls along its OWN heading — the prior "straight down" collapse', () => {
    const t = corpseTopple(0, 0, 0, SETTLED, COLLAPSE, 1.234);
    expect(t.fallYaw).toBeCloseTo(1.234, 6); // crumples forward along heading, no impact push
    expect(t.pitch).toBeCloseTo(CORPSE_PRONE_PITCH, 6);
  });

  it('a directionless impact vector with no force also falls along heading (degenerate guard)', () => {
    const t = corpseTopple(0, 0, 50, SETTLED, COLLAPSE, -0.5);
    expect(t.fallYaw).toBeCloseTo(-0.5, 6); // zero magnitude → no usable direction → heading
  });

  it('stands UPRIGHT at age 0 and lies FLAT + on the ground once settled (feet-pivot collapse)', () => {
    const fresh = corpseTopple(1, 0, 30, 0, COLLAPSE, 0);
    expect(fresh.pitch).toBe(0); // just died → upright
    expect(fresh.lift).toBe(0);
    const settled = corpseTopple(1, 0, 30, SETTLED, COLLAPSE, 0);
    expect(settled.pitch).toBeCloseTo(CORPSE_PRONE_PITCH, 6);
    expect(settled.lift).toBeCloseTo(CORPSE_LIE_HEIGHT, 6);
  });

  it('begins GENTLY (gives, not a snap) — barely moved a moment after death', () => {
    // The damped-spring settle starts at rest (zero velocity), so a sliver into the fall the body has barely tipped.
    const justAfter = corpseTopple(1, 0, 30, COLLAPSE * 0.05, COLLAPSE, 0);
    expect(justAfter.pitch).toBeGreaterThan(0);
    expect(justAfter.pitch).toBeLessThan(CORPSE_PRONE_PITCH * 0.1); // < 10% over — a hesitant give, not a slam
  });

  it('OVER-rotates past flat then ROCKS BACK to rest (organic settle, not a rigid plank stop)', () => {
    // Somewhere during the fall the body tips slightly PAST prone (momentum), then settles back to exactly flat.
    let maxPitch = 0;
    for (let a = 0; a <= COLLAPSE * 2; a += 0.25) maxPitch = Math.max(maxPitch, corpseTopple(1, 0, 40, a, COLLAPSE, 0).pitch);
    expect(maxPitch).toBeGreaterThan(CORPSE_PRONE_PITCH); // over-rotated past flat at the peak of the fall
    expect(maxPitch).toBeLessThan(CORPSE_PRONE_PITCH * 1.15); // ...but only a SMALL (~6°) over-rotation, not a flip
    const settled = corpseTopple(1, 0, 40, SETTLED, COLLAPSE, 0);
    expect(settled.pitch).toBeCloseTo(CORPSE_PRONE_PITCH, 6); // rocked back to rest, flat
  });

  it('FORCE is a SUBTLE nudge to the fall speed, not a cannonball fling', () => {
    const age = COLLAPSE * 0.25; // on the gentle rising part of the fall (before the over-rotation peak)
    const soft = corpseTopple(1, 0, 0, age, COLLAPSE, 0); // force 0
    const ordinary = corpseTopple(1, 0, 30, age, COLLAPSE, 0); // an ordinary kill
    const hard = corpseTopple(1, 0, 200, age, COLLAPSE, 0); // overwhelming hit
    expect(hard.pitch).toBeGreaterThan(soft.pitch); // force still speeds the fall a little
    // an ordinary kill barely differs from a force-less one — it should crumple, not get launched.
    expect(Math.abs(ordinary.pitch - soft.pitch)).toBeLessThan(soft.pitch * 0.5 + 0.05);
    // even an overwhelming hit ends flat (the settle is the same organic rest).
    expect(corpseTopple(1, 0, 200, SETTLED, COLLAPSE, 0).pitch).toBeCloseTo(CORPSE_PRONE_PITCH, 6);
  });

  it('is deterministic — same inputs always yield the same pose (V26)', () => {
    const a = corpseTopple(0.3, -0.95, 17, 7, COLLAPSE, 0.9);
    const b = corpseTopple(0.3, -0.95, 17, 7, COLLAPSE, 0.9);
    expect(b).toEqual(a);
  });
});

describe('toppleForceFactor (T131)', () => {
  it('is 0 for no force and saturates toward 1 (bounded tumble)', () => {
    expect(toppleForceFactor(0)).toBe(0);
    expect(toppleForceFactor(-5)).toBe(0); // negative guarded
    expect(toppleForceFactor(60)).toBeCloseTo(0.5, 6); // == CORPSE_FORCE_HALF → half
    expect(toppleForceFactor(1e6)).toBeGreaterThan(0.99);
    expect(toppleForceFactor(1e6)).toBeLessThan(1);
  });
});

describe('toppleEase (T131/V99) — organic damped settle', () => {
  it('is 0 at the start with a GENTLE give (near-zero velocity), and clamps to 1 once settled', () => {
    expect(toppleEase(0)).toBe(0);
    expect(toppleEase(-1)).toBe(0);
    expect(toppleEase(1)).toBe(1);
    expect(toppleEase(5)).toBe(1);
    expect(toppleEase(0.03)).toBeLessThan(0.05); // barely moving a sliver in — the body gives, doesn't snap
  });

  it('OVER-rotates past 1 mid-fall (the momentum) then rocks back to ~1 (the organic rest)', () => {
    let peak = 0;
    for (let p = 0; p < 1; p += 0.01) peak = Math.max(peak, toppleEase(p));
    expect(peak).toBeGreaterThan(1); // tips past flat at the peak of the fall
    expect(peak).toBeLessThan(1.15); // but only a small over-rotation
    // it has settled close to 1 by the end of the window (no hard pop at the clamp boundary).
    expect(toppleEase(0.999)).toBeGreaterThan(0.985);
    expect(toppleEase(0.999)).toBeLessThan(1.015);
  });
});

describe('collapseProgress / collapseEase (T131, moved from CorpseField)', () => {
  it('progress is 0 at death, ramps, saturates at 1', () => {
    expect(collapseProgress(0, 15)).toBe(0);
    expect(collapseProgress(7.5, 15)).toBeCloseTo(0.5, 6);
    expect(collapseProgress(15, 15)).toBe(1);
    expect(collapseProgress(100, 15)).toBe(1);
    expect(collapseProgress(-5, 15)).toBe(0);
    expect(collapseProgress(3, 0)).toBe(1); // degenerate zero duration → instant settle
  });

  it('ease is a smooth 0→1 with a soft start + landing (smoothstep)', () => {
    expect(collapseEase(0)).toBe(0);
    expect(collapseEase(1)).toBe(1);
    expect(collapseEase(0.5)).toBeCloseTo(0.5, 6);
    expect(collapseEase(0.25)).toBeLessThan(0.25);
    expect(collapseEase(0.25)).toBeGreaterThan(0);
  });
});
