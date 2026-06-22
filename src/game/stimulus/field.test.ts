// Wave-2 shared — StimulusField (V14/V28).

import { describe, it, expect } from 'vitest';
import { StimulusField } from './field';
import type { Stimulus } from '../core/contracts/stimulus';
import type { StimulusId } from '../core/contracts/ids';

function stim(p: Partial<Stimulus> & { x: number; z: number }): Stimulus {
  return {
    id: 0 as StimulusId,
    kind: 'sound',
    source: 'gunfire',
    intensity: 1,
    radius: 10,
    bornTick: 0,
    decayPerTick: 0,
    ...p,
  };
}

describe('StimulusField (V14/V28)', () => {
  it('attenuates intensity with distance inside the radius', () => {
    const f = new StimulusField(8);
    f.emit(stim({ x: 0, z: 0, intensity: 1, radius: 10 }), 0);
    const near = f.query(0, 0, 0);
    const far = f.query(5, 0, 0);
    expect(near[0]!.intensity).toBeCloseTo(1);
    expect(far[0]!.intensity).toBeCloseTo(0.5);
  });

  it('does not reach a point outside the radius', () => {
    const f = new StimulusField(8);
    f.emit(stim({ x: 0, z: 0, radius: 10 }), 0);
    expect(f.query(20, 0, 0)).toHaveLength(0);
  });

  it('decays over ticks and retires on update', () => {
    const f = new StimulusField(8);
    f.emit(stim({ x: 0, z: 0, intensity: 1, decayPerTick: 0.25 }), 0);
    expect(f.query(0, 0, 2)[0]!.intensity).toBeCloseTo(0.5);
    f.update(4); // intensity 1 - 0.25*4 = 0 -> retired
    expect(f.activeCount).toBe(0);
  });

  it('evicts the weakest when full and a stronger arrives', () => {
    const f = new StimulusField(1);
    f.emit(stim({ x: 0, z: 0, intensity: 0.2 }), 0);
    const replaced = f.emit(stim({ x: 1, z: 1, intensity: 0.9 }), 0);
    expect(replaced).toBe(true);
    expect(f.activeCount).toBe(1);
    expect(f.droppedCount).toBe(1);
  });

  it('rejects a weaker stimulus when full', () => {
    const f = new StimulusField(1);
    f.emit(stim({ x: 0, z: 0, intensity: 0.9 }), 0);
    expect(f.emit(stim({ x: 1, z: 1, intensity: 0.1 }), 0)).toBe(false);
  });

  it('rejects bad capacity', () => {
    expect(() => new StimulusField(0)).toThrow();
  });
});
