// BUG1/T60 — the kitchen cupboard is anchored at a FIXED scene cell (not the player cell), so it is the
// nearest interactable ONLY within interaction range of THAT spot — never house-wide. And the runtime exposes
// the nearest interactable as a placed + sized highlight box (null when nothing is in reach).
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildCityDistrict } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { resolveDomain } from '@/config/registry';
import { structuresConfig } from '@/config/domains/structures';

const TIER = 'desktop-high' as const;

function makeRuntime() {
  const d = buildCityDistrict(TIER);
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: d.block, sectors: d.sectors });
}

describe('container fixed placement + active highlight (BUG1/T60)', () => {
  it('anchors the cupboard interactable at a fixed cell, NOT the player position', () => {
    const rt = makeRuntime();
    const cup = rt.interactables().find((t) => t.kind === 'container');
    expect(cup).toBeDefined();
    const p = rt.player();
    // the cupboard does NOT sit on top of the player at spawn (the old playerCell-anchor bug).
    expect(Math.hypot(cup!.x - p.x, cup!.z - p.z)).toBeGreaterThan(0.5);
  });

  it('at spawn nothing is in reach → no active highlight (not house-wide)', () => {
    const rt = makeRuntime();
    expect(rt.nearestInteractableHighlight()).toBeNull();
  });

  it('walking up to the cupboard makes it the nearest interactable + emits a sized highlight box', () => {
    const rt = makeRuntime();
    const cup = rt.interactables().find((t) => t.kind === 'container')!;
    const range = resolveDomain(structuresConfig, TIER).interactionRangeMeters;
    // step toward the cupboard until within reach (walkable interior path; slides on walls).
    for (let i = 0; i < 400; i++) {
      const p = rt.player();
      const dx = cup.x - p.x;
      const dz = cup.z - p.z;
      if (Math.hypot(dx, dz) <= range - 0.5) break;
      rt.movePlayer(dx, dz, 0.1);
    }
    const p = rt.player();
    expect(Math.hypot(cup.x - p.x, cup.z - p.z)).toBeLessThanOrEqual(range);

    const hl = rt.nearestInteractableHighlight();
    expect(hl).not.toBeNull();
    expect(hl!.kind).toBe('container');
    // sized to the cabinet dims (the box hugs the cupboard mesh), resting on the floor.
    const cfg = resolveDomain(structuresConfig, TIER);
    expect(hl!.sizeX).toBeCloseTo(cfg.cupboardWidthMeters);
    expect(hl!.sizeY).toBeCloseTo(cfg.cupboardHeightMeters);
    expect(hl!.sizeZ).toBeCloseTo(cfg.cupboardDepthMeters);
    expect(hl!.y).toBeCloseTo(cfg.cupboardHeightMeters / 2);
  });
});
