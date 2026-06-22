// T25 tests — each modification class feeds the world consistently: a persistent WorldEvent, a sound
// Stimulus emitted into the StimulusField (V14/V28), and a LOCAL nav/path consequence (V5). Reuses the
// existing breach path (no full rebuild). Functional + obstruction state is a compact persistent delta.

import { describe, it, expect } from 'vitest';
import { StructuralModule } from './structuralModule';
import { StructureModifier, type ModifierDeps } from './modifications';
import { StimulusField } from '@/game/stimulus';
import { IdFactory } from '@/game/core/ids';
import type { Command, CommandId, EventId, ModuleId, WorldEvent } from '@/game/core/contracts';

const MODULE_ID = 1 as ModuleId;

function wallModule(): StructuralModule {
  const m = new StructuralModule({ id: MODULE_ID, sizeX: 6, sizeY: 1, sizeZ: 1, seed: 3 });
  for (let x = 0; x < 6; x++) m.addCell({ x, y: 0, z: 0, material: 'brick', family: 0, strength: 100 });
  // mark the middle cell an authored opening (a door we can lock/board/open)
  return m;
}

function harness() {
  const ids = new IdFactory();
  const field = new StimulusField(64);
  const events: WorldEvent[] = [];
  const blocked: number[] = [];
  const opened: number[] = [];
  const obstructed: { cell: number; cost: number }[] = [];
  const deps: ModifierDeps = {
    ids,
    field,
    emit: (e) => events.push(e),
    locate: (_m, cell) => ({ x: cell, z: 0 }),
    blockCell: (_m, cell) => blocked.push(cell),
    openCell: (_m, cell) => opened.push(cell),
    obstructCell: (_m, cell, cost) => obstructed.push({ cell, cost }),
  };
  return { ids, field, events, blocked, opened, obstructed, mod: new StructureModifier(deps) };
}

describe('modification classes (T25) — events + sound stimulus + nav consequence', () => {
  it('board: adds strength, blocks nav, emits structureModified + a sound stimulus', () => {
    const h = harness();
    const m = wallModule();
    const cell = m.packCell(2, 0, 0);
    const before = m.getCell(cell)!.strength;
    h.mod.board(m, cell, 0);

    expect(m.getCell(cell)!.strength).toBeGreaterThan(before); // hardened
    expect(h.blocked).toContain(cell); // local nav consequence
    expect(h.events.some((e) => e.kind === 'structureModified' && e.cell === cell)).toBe(true);
    // a sound stimulus reached the field at the cell's world position
    const hits = h.field.query(cell, 0, 0);
    expect(hits.some((hit) => hit.stimulus.kind === 'sound')).toBe(true);
    // compact functional delta records the board
    expect(h.mod.getState(MODULE_ID, cell)?.boarded).toBe(true);
  });

  it('breach: reuses applyDamage, opens nav locally, emits breachCreated + a breach sound', () => {
    const h = harness();
    const m = wallModule();
    const cell = m.packCell(3, 0, 0);
    const result = h.mod.breach(m, cell, 5);

    expect(result.breached).toContain(cell);
    expect(m.isPassable(cell)).toBe(true);
    expect(h.opened).toContain(cell); // local nav OPEN (V5)
    expect(h.events.some((e) => e.kind === 'breachCreated' && e.cell === cell)).toBe(true);
    const hits = h.field.query(cell, 0, 5);
    expect(hits.some((hit) => hit.stimulus.source === 'breach')).toBe(true);
  });

  it('obstruct: adds a local path cost + emits a sound', () => {
    const h = harness();
    const m = wallModule();
    const cell = m.packCell(1, 0, 0);
    h.mod.obstruct(m, cell, 0);
    expect(h.obstructed).toEqual([{ cell, cost: h.mod.settings.obstructionNavCost }]);
    expect(h.mod.getState(MODULE_ID, cell)?.obstructed).toBe(true);
    expect(h.field.activeCount).toBeGreaterThan(0);
  });

  it('reinforce hardens a cell so more damage is needed to breach it', () => {
    const h = harness();
    const plain = wallModule();
    const hard = wallModule();
    const cell = plain.packCell(0, 0, 0);
    h.mod.reinforce(hard, cell, 0);
    // 100 damage breaches the plain wall but not the reinforced one.
    const hooks = { nextEventId: () => h.ids.next<EventId>('event'), emit: () => {} };
    expect(plain.applyDamage(cell, 100, hooks)).not.toBeNull();
    expect(hard.applyDamage(cell, 100, hooks)).toBeNull();
  });
});

describe('modification classes — command + access state', () => {
  it('apply(modifyStructure board) succeeds; a module mismatch fails with a reason', () => {
    const h = harness();
    const m = wallModule();
    const cell = m.packCell(4, 0, 0);
    const ok: Command = { kind: 'modifyStructure', id: 0 as CommandId, module: MODULE_ID, cell, op: 'board' };
    expect(h.mod.apply(ok, m, 0).ok).toBe(true);

    const wrong: Command = { kind: 'modifyStructure', id: 1 as CommandId, module: 999 as ModuleId, cell, op: 'board' };
    const res = h.mod.apply(wrong, m, 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('module-mismatch');
  });

  it('opening a locked cell fails clearly (functional-mod access rules)', () => {
    const h = harness();
    const m = wallModule();
    const cell = m.packCell(5, 0, 0);
    h.mod.lock(m, cell, 0);
    expect(() => h.mod.open(m, cell, 0)).toThrow(/locked/);
    h.mod.unlock(m, cell, 0);
    expect(() => h.mod.open(m, cell, 0)).not.toThrow();
    expect(h.opened).toContain(cell);
  });
});
