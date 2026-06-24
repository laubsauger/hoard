// T108 — WindowSystem render reflect: an opening (glass gone, unboarded) is a CLEAR hole (no dark void fill);
// boards get a dark backing; intact shows glass. Pure visibility toggles, testable with stub meshes.
import { describe, it, expect } from 'vitest';
import { WindowSystem } from './windowSystem';
import type { WindowMesh } from '../builders/handles';
import type { GameRuntime } from '../../../game/runtime';
import type { WindowGlass } from '../../../game/scene';

type Vis = { visible: boolean };
function unit(navCell: number): WindowMesh & { pane: Vis; voidMesh: Vis; boards: Vis[] } {
  return {
    navCell,
    pane: { visible: true },
    voidMesh: { visible: true },
    boards: [{ visible: true }, { visible: true }, { visible: true }],
  } as unknown as WindowMesh & { pane: Vis; voidMesh: Vis; boards: Vis[] };
}
function runtimeWith(views: { cx: number; cy: number; glass: WindowGlass; boards: number }[]): GameRuntime {
  return {
    windowViews: () => views,
    scene: { navGrid: { index: (x: number, y: number) => y * 1000 + x } },
  } as unknown as GameRuntime;
}

describe('WindowSystem render reflect (T108)', () => {
  it('intact → glass pane shown, no void, no boards', () => {
    const u = unit(5);
    new WindowSystem([u]).sync(runtimeWith([{ cx: 5, cy: 0, glass: 'intact', boards: 0 }]));
    expect(u.pane.visible).toBe(true);
    expect(u.voidMesh.visible).toBe(false);
    expect(u.boards.every((b) => !b.visible)).toBe(true);
  });

  it('open OR smashed + unboarded → CLEAR hole: no pane AND no dark void fill (the see-through fix)', () => {
    for (const glass of ['open', 'smashed'] as const) {
      const u = unit(5);
      new WindowSystem([u]).sync(runtimeWith([{ cx: 5, cy: 0, glass, boards: 0 }]));
      expect(u.pane.visible).toBe(false);
      expect(u.voidMesh.visible).toBe(false); // no dark wall — you see straight through
    }
  });

  it('boards lay OVER the glass/hole with NO dark fill — see-through between the planks', () => {
    // boarded-over-an-open-hole: planks shown, glass off, and crucially NO void box (see through the gaps).
    const open = unit(5);
    new WindowSystem([open]).sync(runtimeWith([{ cx: 5, cy: 0, glass: 'smashed', boards: 2 }]));
    expect(open.voidMesh.visible).toBe(false); // the fix — never a dark backing
    expect(open.pane.visible).toBe(false);
    expect(open.boards[0]!.visible).toBe(true);
    expect(open.boards[1]!.visible).toBe(true);
    expect(open.boards[2]!.visible).toBe(false);
    // boarded-over-intact-glass: glass kept, planks over it, still no void.
    const glazed = unit(7);
    new WindowSystem([glazed]).sync(runtimeWith([{ cx: 7, cy: 0, glass: 'intact', boards: 1 }]));
    expect(glazed.pane.visible).toBe(true);
    expect(glazed.voidMesh.visible).toBe(false);
    expect(glazed.boards[0]!.visible).toBe(true);
  });
});
