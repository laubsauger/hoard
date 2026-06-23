// T55 / V24 / V33 — CorpseField render view: pooled instanced bodies mirroring the sim corpse list.
// Construction is GPU-free (InstancedMesh just allocates typed arrays), so the view is node-testable.

import { describe, it, expect } from 'vitest';
import { Matrix4 } from 'three';
import { CorpseField, resolveCorpseFieldSettings } from './corpseField';
import { ResourceRegistry } from '../engine/resources';
import type { Corpse } from '../../game/zombie';

function corpse(over: Partial<Corpse> = {}): Corpse {
  return { entity: 1, x: 0, y: 0, z: 0, heading: 0, archetype: 0, severedFlags: 0, bornTick: 0, ...over };
}

describe('CorpseField (T55)', () => {
  it('pre-creates the instanceColor binding (r184 binding-safe) and starts with 0 drawn', () => {
    const reg = new ResourceRegistry();
    const field = new CorpseField({ capacity: 16 }, reg);
    expect(field.mesh.instanceColor).not.toBeNull();
    expect(field.mesh.count).toBe(0);
    // geometry + material + instanced mesh all tracked for disposal (V24).
    expect(reg.size).toBe(3);
  });

  it('mirrors the live corpse list onto the instanced batch (draw count = corpses)', () => {
    const reg = new ResourceRegistry();
    const field = new CorpseField({ capacity: 16 }, reg);
    const list: Corpse[] = [corpse({ entity: 1, x: 2 }), corpse({ entity: 2, x: 5, severedFlags: 0b11 })];
    const drawn = field.update(list);
    expect(drawn).toBe(2);
    expect(field.mesh.count).toBe(2);
    // A toppled body sits on the ground: the per-instance Y translation is the configured lie height (>0),
    // confirming the matrix was actually written for a drawn instance (needsUpdate is a write-only setter).
    const m = new Matrix4();
    field.mesh.getMatrixAt(0, m);
    expect(m.elements[13]).toBeGreaterThan(0);
  });

  it('caps the drawn instances at capacity even if more corpses are passed', () => {
    const reg = new ResourceRegistry();
    const field = new CorpseField({ capacity: 2 }, reg);
    const list = [corpse({ entity: 1 }), corpse({ entity: 2 }), corpse({ entity: 3 })];
    expect(field.update(list)).toBe(2);
    expect(field.mesh.count).toBe(2);
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
