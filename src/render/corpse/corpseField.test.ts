// T55 / V17 / V24 / V33 — CorpseField render view: pooled instanced LIMBED bodies (head/torso/arms/legs)
// toppled flat, mirroring the sim corpse list. Construction is GPU-free (InstancedMesh just allocates typed
// arrays), so the view is node-testable. Severed parts persist through death (V17).

import { describe, it, expect } from 'vitest';
import { Matrix4 } from 'three';
import { CorpseField, resolveCorpseFieldSettings, collapseProgress, collapseEase } from './corpseField';
import { ResourceRegistry } from '../engine/resources';
import { regionBit } from '../../game/combat/anatomy';
import type { Corpse } from '../../game/zombie';

// CROWD_LIMB_PARTS order: [0]legLeft [1]legRight [2]torso [3]head [4]armLeft [5]armRight.
const TORSO = 2;
const ARM_LEFT = 4;
const COLLAPSE = 15; // collapse duration (ticks) used in these tests
// A "now" far past any bornTick so a corpse reads FULLY SETTLED (collapse done) — the steady-state the original
// (pre-collapse) assertions describe.
const SETTLED = 10_000;

function settings(capacity: number) {
  return { capacity, collapseTicks: COLLAPSE };
}

function corpse(over: Partial<Corpse> = {}): Corpse {
  return { entity: 1, x: 0, y: 0, z: 0, heading: 0, archetype: 0, severedFlags: 0, bornTick: 0, ...over };
}

describe('CorpseField (T55) — toppled limbed bodies', () => {
  it('pre-creates the instanceColor binding (r184 binding-safe) on every part and starts with 0 drawn', () => {
    const reg = new ResourceRegistry();
    const field = new CorpseField(settings(16), reg);
    for (const m of field.meshes) {
      expect(m.instanceColor).not.toBeNull();
      expect(m.count).toBe(0);
    }
    expect(field.meshes.length).toBe(6); // a 6-part humanoid
    // geometry + material + instanced mesh tracked per part for disposal (V24): 6 × 3.
    expect(reg.size).toBe(18);
  });

  it('mirrors the live corpse list onto every part batch (draw count = corpses)', () => {
    const reg = new ResourceRegistry();
    const field = new CorpseField(settings(16), reg);
    const list: Corpse[] = [corpse({ entity: 1, x: 2 }), corpse({ entity: 2, x: 5 })];
    const drawn = field.update(list, SETTLED);
    expect(drawn).toBe(2);
    for (const m of field.meshes) expect(m.count).toBe(2);
    // A toppled body sits on the ground: the torso instance Y translation is positive (lifted off the floor).
    const m = new Matrix4();
    field.meshes[TORSO]!.getMatrixAt(0, m);
    expect(m.elements[13]).toBeGreaterThan(0);
  });

  it('PERSISTS dismemberment through death (V17): a severed part is hidden, others drawn', () => {
    const reg = new ResourceRegistry();
    const field = new CorpseField(settings(16), reg);
    field.update([corpse({ severedFlags: regionBit('armLeft') })], SETTLED);
    const m = new Matrix4();
    // Severed arm → a degenerate (all-zero) matrix → element[15] (the w) is 0 instead of 1.
    field.meshes[ARM_LEFT]!.getMatrixAt(0, m);
    expect(m.elements[15]).toBe(0);
    // Torso (never severable) is drawn normally → a proper affine matrix (w = 1).
    field.meshes[TORSO]!.getMatrixAt(0, m);
    expect(m.elements[15]).toBe(1);
  });

  it('caps the drawn instances at capacity even if more corpses are passed', () => {
    const reg = new ResourceRegistry();
    const field = new CorpseField(settings(2), reg);
    const list = [corpse({ entity: 1 }), corpse({ entity: 2 }), corpse({ entity: 3 })];
    expect(field.update(list, SETTLED)).toBe(2);
    for (const m of field.meshes) expect(m.count).toBe(2);
  });

  it('disposes cleanly with no leaked resources (V24)', () => {
    const reg = new ResourceRegistry();
    const field = new CorpseField(settings(4), reg);
    field.update([corpse()], SETTLED);
    reg.disposeAll();
    expect(() => reg.assertNoLeaks()).not.toThrow();
  });

  it('resolves a positive instanced capacity + collapse duration from config (V4)', () => {
    const s = resolveCorpseFieldSettings('desktop-high');
    expect(s.capacity).toBeGreaterThan(0);
    expect(s.collapseTicks).toBeGreaterThan(0);
  });

  it('COLLAPSES standing → prone by tick age (T122/V87): upright fresh, toppled once settled', () => {
    const reg = new ResourceRegistry();
    const field = new CorpseField(settings(4), reg);
    const m = new Matrix4();
    // Fresh (age 0): the torso reads UPRIGHT — its world Y is near the standing torso height (~1.2 m).
    field.update([corpse({ bornTick: 100 })], 100);
    field.meshes[TORSO]!.getMatrixAt(0, m);
    const uprightY = m.elements[13]!;
    expect(uprightY).toBeGreaterThan(0.8); // still standing, not slammed flat
    // Fully settled (age ≥ collapse): the torso has toppled flat — its world Y collapses toward the lie clearance.
    field.update([corpse({ bornTick: 100 })], 100 + COLLAPSE);
    field.meshes[TORSO]!.getMatrixAt(0, m);
    const proneY = m.elements[13]!;
    expect(proneY).toBeLessThan(0.5);
    expect(uprightY).toBeGreaterThan(proneY); // it sank as it fell
  });

  it('death-collapse pose is deterministic for a given tick age (V26) — no per-frame randomness', () => {
    const reg = new ResourceRegistry();
    const field = new CorpseField(settings(4), reg);
    const a = new Matrix4();
    const b = new Matrix4();
    field.update([corpse({ entity: 9, bornTick: 0 })], 7);
    field.meshes[TORSO]!.getMatrixAt(0, a);
    field.update([corpse({ entity: 9, bornTick: 0 })], 7);
    field.meshes[TORSO]!.getMatrixAt(0, b);
    expect(Array.from(b.elements)).toEqual(Array.from(a.elements));
  });
});

describe('collapseProgress / collapseEase (T122/V87)', () => {
  it('progress is 0 at death, ramps, and saturates at 1 once collapsed', () => {
    expect(collapseProgress(0, 15)).toBe(0);
    expect(collapseProgress(7.5, 15)).toBeCloseTo(0.5, 6);
    expect(collapseProgress(15, 15)).toBe(1);
    expect(collapseProgress(100, 15)).toBe(1); // a long-settled / save-restored body is fully prone
    expect(collapseProgress(-5, 15)).toBe(0); // clock skew never un-collapses
    expect(collapseProgress(3, 0)).toBe(1); // zero duration → instant settle (degenerate config)
  });

  it('ease is a smooth 0→1 with a soft start + landing (smoothstep)', () => {
    expect(collapseEase(0)).toBe(0);
    expect(collapseEase(1)).toBe(1);
    expect(collapseEase(0.5)).toBeCloseTo(0.5, 6);
    expect(collapseEase(0.25)).toBeLessThan(0.25); // eased-in (slow start)
    expect(collapseEase(0.25)).toBeGreaterThan(0); // but already moving
  });
});
