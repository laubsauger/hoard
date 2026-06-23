// B17 / V1 — boarding a breached cell must FAIL gracefully (explicit CommandResult), never throw.
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildTestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import type { CommandId, ModuleId } from '@/game/core/contracts';

const TIER = 'desktop-high' as const;

function makeRuntime() {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildTestBlock() });
}

describe('board wall command (B17/V1)', () => {
  it('boarding a breached cell returns ok:false (no thrown exception)', () => {
    const rt = makeRuntime();
    const module = rt.scene.moduleId as ModuleId;
    const cell = rt.defaultBreachCell();
    const breach = rt.dispatch({ kind: 'modifyStructure', id: 1 as CommandId, module, cell, op: 'breach' });
    expect(breach.ok).toBe(true);

    const board = rt.dispatch({ kind: 'modifyStructure', id: 2 as CommandId, module, cell, op: 'board' });
    expect(board.ok).toBe(false);
    if (!board.ok) expect(board.reason).toMatch(/breached/);
  });

  it('boarding an intact cell succeeds', () => {
    const rt = makeRuntime();
    const module = rt.scene.moduleId as ModuleId;
    const board = rt.dispatch({ kind: 'modifyStructure', id: 1 as CommandId, module, cell: rt.defaultBreachCell(), op: 'board' });
    expect(board.ok).toBe(true);
  });
});
