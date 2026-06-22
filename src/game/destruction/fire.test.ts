// T26 tests — fire ignites flammable cells (and refuses non-flammable), spreads to neighbours, deals
// damage-over-time, emits a `fire` Stimulus into the field + a fireIgnited event, decays when fuel is
// gone, and round-trips as compact persistent state (V18).

import { describe, it, expect } from 'vitest';
import { StructuralModule } from './structuralModule';
import { FireSim, type FireDeps } from './fire';
import { StimulusField } from '@/game/stimulus';
import { IdFactory } from '@/game/core/ids';
import type { ModuleId, WorldEvent } from '@/game/core/contracts';

const MODULE_ID = 7 as ModuleId;

function woodRow(len: number): StructuralModule {
  const m = new StructuralModule({ id: MODULE_ID, sizeX: len, sizeY: 1, sizeZ: 1, seed: 9 });
  for (let x = 0; x < len; x++) m.addCell({ x, y: 0, z: 0, material: 'wood', family: 0, strength: 100 });
  return m;
}

function deps(field: StimulusField, events: WorldEvent[]): FireDeps {
  return {
    ids: new IdFactory(),
    field,
    emit: (e) => events.push(e),
    locate: (_m, cell) => ({ x: cell, z: 0 }),
    seed: 1,
  };
}

describe('fire — ignition + stimulus + DoT', () => {
  it('ignites flammable wood, emits a fireIgnited event + a fire Stimulus into the field', () => {
    const field = new StimulusField(64);
    const events: WorldEvent[] = [];
    const m = woodRow(3);
    const fire = new FireSim(m, deps(field, events));
    const cell = m.packCell(1, 0, 0);
    expect(fire.ignite(cell, 0)).toBe(true);
    expect(events.some((e) => e.kind === 'fireIgnited' && e.cell === cell)).toBe(true);
    const hits = field.query(1, 0, 0);
    expect(hits.some((h) => h.stimulus.kind === 'fire')).toBe(true);
  });

  it('refuses to ignite a non-flammable cell unless explicit fuel is supplied', () => {
    const field = new StimulusField(16);
    const m = new StructuralModule({ id: MODULE_ID, sizeX: 1, sizeY: 1, sizeZ: 1 });
    const cell = m.addCell({ x: 0, y: 0, z: 0, material: 'concrete', family: 0, strength: 100 });
    const fire = new FireSim(m, deps(field, []));
    expect(fire.ignite(cell, 0)).toBe(false); // concrete won't catch
    expect(fire.ignite(cell, 0, 50)).toBe(true); // ...but a fuel source on it will
  });

  it('spreads to adjacent flammable cells and damages the structure over time', () => {
    const field = new StimulusField(64);
    const m = woodRow(3);
    const fire = new FireSim(m, deps(field, []));
    const mid = m.packCell(1, 0, 0);
    fire.ignite(mid, 0);
    const before = m.getCell(mid)!.strength;
    fire.update(4, 1); // strong step -> guaranteed spread + DoT
    expect(m.getCell(mid)!.strength).toBeLessThan(before); // damage-over-time
    expect(fire.isBurning(m.packCell(0, 0, 0))).toBe(true);
    expect(fire.isBurning(m.packCell(2, 0, 0))).toBe(true);
    expect(fire.light).toBeGreaterThan(0);
    expect(fire.smoke).toBeGreaterThan(0);
  });
});

describe('fire — burnout + persistence (V18)', () => {
  it('extinguishes once fuel is exhausted', () => {
    const field = new StimulusField(64);
    const m = woodRow(1); // isolated cell, nothing to spread to
    const fire = new FireSim(m, deps(field, []));
    fire.ignite(m.packCell(0, 0, 0), 0, 10); // small fuel
    for (let t = 1; t <= 5; t++) fire.update(2, t);
    expect(fire.burningCount).toBe(0);
  });

  it('fire state round-trips through a compact snapshot', () => {
    const field = new StimulusField(64);
    const m = woodRow(2);
    const fire = new FireSim(m, deps(field, []));
    const cell = m.packCell(0, 0, 0);
    fire.ignite(cell, 0);
    fire.update(1, 1);
    const snap = fire.fireDelta();
    expect(snap.length).toBeGreaterThan(0);

    const m2 = woodRow(2);
    const fire2 = new FireSim(m2, deps(new StimulusField(64), []));
    fire2.applyFireSnapshot(snap);
    expect(fire2.isBurning(cell)).toBe(true);
    expect(fire2.getBurning(cell)?.fuel).toBeCloseTo(fire.getBurning(cell)!.fuel);
  });
});
