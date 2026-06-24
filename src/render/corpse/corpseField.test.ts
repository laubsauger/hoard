// T55 / V17 / V24 / V33 — CorpseField render view: pooled instanced LIMBED bodies (head/torso/arms/legs)
// toppled flat, mirroring the sim corpse list. Construction is GPU-free (InstancedMesh just allocates typed
// arrays), so the view is node-testable. Severed parts persist through death (V17).

import { describe, it, expect } from 'vitest';
import { Matrix4 } from 'three';
import { CorpseField, resolveCorpseFieldSettings } from './corpseField';
import { ResourceRegistry } from '../engine/resources';
import { regionBit } from '../../game/combat/anatomy';
import type { Corpse } from '../../game/zombie';

// CROWD_LIMB_PARTS order: [0]legLeft [1]legRight [2]torso [3]head [4]armLeft [5]armRight.
const TORSO = 2;
const ARM_LEFT = 4;

function corpse(over: Partial<Corpse> = {}): Corpse {
  return { entity: 1, x: 0, y: 0, z: 0, heading: 0, archetype: 0, severedFlags: 0, bornTick: 0, ...over };
}

describe('CorpseField (T55) — toppled limbed bodies', () => {
  it('pre-creates the instanceColor binding (r184 binding-safe) on every part and starts with 0 drawn', () => {
    const reg = new ResourceRegistry();
    const field = new CorpseField({ capacity: 16 }, reg);
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
    const field = new CorpseField({ capacity: 16 }, reg);
    const list: Corpse[] = [corpse({ entity: 1, x: 2 }), corpse({ entity: 2, x: 5 })];
    const drawn = field.update(list);
    expect(drawn).toBe(2);
    for (const m of field.meshes) expect(m.count).toBe(2);
    // A toppled body sits on the ground: the torso instance Y translation is positive (lifted off the floor).
    const m = new Matrix4();
    field.meshes[TORSO]!.getMatrixAt(0, m);
    expect(m.elements[13]).toBeGreaterThan(0);
  });

  it('PERSISTS dismemberment through death (V17): a severed part is hidden, others drawn', () => {
    const reg = new ResourceRegistry();
    const field = new CorpseField({ capacity: 16 }, reg);
    field.update([corpse({ severedFlags: regionBit('armLeft') })]);
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
    const field = new CorpseField({ capacity: 2 }, reg);
    const list = [corpse({ entity: 1 }), corpse({ entity: 2 }), corpse({ entity: 3 })];
    expect(field.update(list)).toBe(2);
    for (const m of field.meshes) expect(m.count).toBe(2);
  });

  it('disposes cleanly with no leaked resources (V24)', () => {
    const reg = new ResourceRegistry();
    const field = new CorpseField({ capacity: 4 }, reg);
    field.update([corpse()]);
    reg.disposeAll();
    expect(() => reg.assertNoLeaks()).not.toThrow();
  });

  it('resolves a positive instanced capacity from config (V4)', () => {
    const s = resolveCorpseFieldSettings('desktop-high');
    expect(s.capacity).toBeGreaterThan(0);
  });
});
