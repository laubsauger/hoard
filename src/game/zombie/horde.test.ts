// T20 / V14 / V19 — horde group dynamics + structural pressure on barricades.
import { describe, it, expect } from 'vitest';
import { summarizeHorde, groupAttraction, BarricadePressure, type HordeMember } from '@/game/zombie';

function members(positions: readonly [number, number][], vel: [number, number]): HordeMember[] {
  return positions.map(([x, z]) => ({ x, z, vx: vel[0], vz: vel[1] }));
}

describe('T20 horde momentum / density / attraction (derived, not one entity)', () => {
  it('computes shared momentum + centroid from members', () => {
    const m = members([[0, 0], [2, 0], [4, 0]], [1, 0]);
    const s = summarizeHorde(m, 3);
    expect(s.count).toBe(3);
    expect(s.centroidX).toBeCloseTo(2);
    expect(s.momentumX).toBeCloseTo(1);
    expect(s.speed).toBeCloseTo(1);
  });

  it('flags crowd pressure when density crosses the configured threshold (V19)', () => {
    const dense = summarizeHorde(members(new Array(12).fill([0, 0]), [0, 0]), 1);
    const sparse = summarizeHorde(members(new Array(4).fill([0, 0]), [0, 0]), 8);
    expect(dense.underPressure).toBe(true);
    expect(sparse.underPressure).toBe(false);
  });

  it('treats a large enough cluster as a shared flow-field group (V15)', () => {
    expect(summarizeHorde(members(new Array(10).fill([0, 0]), [0, 0]), 1).isGroup).toBe(true);
    expect(summarizeHorde(members(new Array(3).fill([0, 0]), [0, 0]), 1).isGroup).toBe(false);
  });

  it('aggregates a shared attraction point from per-member perception', () => {
    const a = groupAttraction([
      { x: 0, z: 0, intensity: 1 },
      { x: 10, z: 0, intensity: 1 },
    ]);
    expect(a).not.toBeNull();
    expect(a!.x).toBeCloseTo(5);
    expect(groupAttraction([{ x: 0, z: 0, intensity: 0 }])).toBeNull();
  });
});

describe('V19 group action weakens a barricade under repeated pressure', () => {
  it('a single light tick releases no damage; sustained pressure breaks it down', () => {
    const bp = new BarricadePressure('desktop-high');
    expect(bp.tick(1)).toBe(0); // light contact does nothing
    expect(bp.accumulated).toBeGreaterThan(0);

    const bp2 = new BarricadePressure('desktop-high');
    let released = 0;
    for (let t = 0; t < 5; t++) released += bp2.tick(8); // 8 members pressing for 5 ticks
    expect(released).toBeGreaterThan(0); // threshold crossed → structural damage applied
  });

  it('forwards released damage to the barricade sink', () => {
    const bp = new BarricadePressure('desktop-high');
    let applied = 0;
    const sink = { applyDamage: (a: number) => (applied += a) };
    for (let t = 0; t < 50; t++) bp.tickInto(8, sink);
    expect(applied).toBeGreaterThan(0);
  });
});
