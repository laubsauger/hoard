// BreachSystem: a section's meshes hide exactly when its structural cell reports breached, and isSectionHidden
// reflects that. Pure CPU — fakes the wall.isBreached oracle + plain Object3D meshes.

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { BreachSystem } from './breachSystem';
import type { TestBlock } from '../../../game/scene';
import type { SectionMesh } from '../builders/handles';

function fakeTown(breached: Set<number>): TestBlock {
  return { wall: { isBreached: (cell: number) => breached.has(cell) } } as unknown as TestBlock;
}

describe('BreachSystem', () => {
  it('toggles section visibility to match the breach state and reports it', () => {
    const a: SectionMesh = { cell: 1, objects: [new Object3D(), new Object3D()] };
    const b: SectionMesh = { cell: 2, objects: [new Object3D()] };
    const sys = new BreachSystem([a, b]);

    const breached = new Set<number>();
    sys.sync(fakeTown(breached));
    expect(a.objects.every((o) => o.visible)).toBe(true);
    expect(sys.isSectionHidden(1)).toBe(false);

    breached.add(1);
    sys.sync(fakeTown(breached));
    expect(a.objects.every((o) => !o.visible)).toBe(true);
    expect(b.objects.every((o) => o.visible)).toBe(true);
    expect(sys.isSectionHidden(1)).toBe(true);
    expect(sys.isSectionHidden(2)).toBe(false);

    // un-breach restores visibility (the render only reflects sim state).
    breached.delete(1);
    sys.sync(fakeTown(breached));
    expect(sys.isSectionHidden(1)).toBe(false);
  });

  it('reports false for an unknown structural cell', () => {
    const sys = new BreachSystem([{ cell: 7, objects: [new Object3D()] }]);
    expect(sys.isSectionHidden(999)).toBe(false);
  });
});
