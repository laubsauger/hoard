// T108 — window feature wiring at the runtime level: the player is equipped to board windows, the scene
// seeds windows from the authored placements, and windows surface as interactables. Windows govern shot
// occlusion + render only — they never alter nav passability (§G — a perimeter window must not unseal room A).
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildCityDistrict } from '@/game/scene';
import { ITEM } from '@/game/inventory';
import { InMemoryPersistenceAdapter } from '@/game/persistence';

const TIER = 'desktop-high' as const;

function makeRuntime() {
  const district = buildCityDistrict(TIER);
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: district.block, sectors: district.sectors });
}

describe('runtime windows (T108)', () => {
  it('equips the player with a hammer + a stack of planks by default', () => {
    const rt = makeRuntime();
    const player = rt.inventorySnapshot().find((c) => c.container === 'player')!;
    const items = new Map(player.slots.map((s) => [s.item, s.count]));
    expect(items.get(ITEM.Hammer)).toBe(1);
    expect(items.get(ITEM.WoodPlank)).toBeGreaterThan(0);
  });

  it('seeds windows from the authored placements + surfaces them as interactables', () => {
    const rt = makeRuntime();
    const views = rt.windowViews();
    expect(views.length).toBeGreaterThan(0);
    // some windows start as authored openings (glassless) — the user wants glassless windows from the start.
    expect(views.some((w) => w.glass !== 'intact' || w.boards > 0)).toBe(true);

    const windowTargets = rt.interactables().filter((t) => t.kind === 'window');
    expect(windowTargets.length).toBe(views.length);
    expect(windowTargets[0]).toMatchObject({ kind: 'window', label: 'Window' });
    expect(typeof windowTargets[0]!.glass).toBe('string');
  });

  it('every window cell stays a BLOCKED nav wall regardless of state (§G — windows never unseal a room)', () => {
    const rt = makeRuntime();
    const grid = rt.scene.navGrid;
    for (const w of rt.windowViews()) {
      expect(grid.isBlocked(grid.index(w.cx, w.cy))).toBe(true);
    }
  });
});
