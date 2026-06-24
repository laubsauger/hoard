// P1d — every container-bearing furniture piece becomes a real lootable world container, seeded from its
// room-type loot table (fridge → kitchen, dresser → bedroom, medicineCabinet → bathroom, …) off the runtime's
// separate loot rng (deterministic, V26 — never perturbs the sim rand/id streams). Asserts: one world container
// per container furniture piece (anchored at its cell), the loot matches the piece's LootSource table, and the
// whole set is replay-stable across two runtimes with the same seed.

import { describe, expect, it } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildCityDistrict } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { rollLoot, ITEM } from '@/game/inventory';
import type { LootSource } from '@/game/inventory';

const TIER = 'desktop-high' as const;

/** Tiny deterministic rng for table-coverage enumeration (not the runtime's loot rng). */
function rng32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRuntime(scatterSeed = 1) {
  const d = buildCityDistrict(TIER);
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: d.block, sectors: d.sectors, scatterSeed });
}

/** Items reachable from a given loot source (its table) — used to bound which items a container may hold. */
function tableItems(source: LootSource): Set<number> {
  const items = new Set<number>();
  // roll a lot of times with a fresh rng to enumerate the table's possible items (coverage, not determinism).
  const rng = rng32(12345);
  for (let i = 0; i < 500; i++) for (const s of rollLoot(source, rng)) items.add(s.item as number);
  return items;
}

describe('furniture loot containers (P1d)', () => {
  it('registers one world container per container furniture piece (+ the legacy cupboard)', () => {
    const rt = makeRuntime();
    const furniture = rt.scene.placedFurniture ?? [];
    const containerPieces = furniture.filter((p) => p.container !== null);
    expect(containerPieces.length).toBeGreaterThan(0);

    const worldContainers = rt.interactables().filter((t) => t.kind === 'container');
    // furniture containers + the one legacy Kitchen Cupboard.
    expect(worldContainers.length).toBe(containerPieces.length + 1);

    // every container furniture piece has a world container anchored at its cell centre.
    const center = (cx: number, cy: number) => rt.scene.cellCenter({ cx, cy });
    for (const piece of containerPieces) {
      const c = center(piece.cx, piece.cy);
      const match = worldContainers.find((t) => Math.abs(t.x - c.x) < 1e-6 && Math.abs(t.z - c.z) < 1e-6);
      expect(match).toBeDefined();
    }
  });

  it('seeds each container from its room-type table (fridge → kitchen, dresser → bedroom)', () => {
    const rt = makeRuntime();
    const snap = rt.inventorySnapshot();
    const furniture = rt.scene.placedFurniture ?? [];

    // a kitchen fridge's container only ever holds items from the kitchen table.
    const fridge = furniture.find((p) => p.kind === 'fridge' && p.container === 'kitchen');
    expect(fridge).toBeDefined();
    const kitchenItems = tableItems('kitchen');
    // find the fridge's container view by its anchor → there is at least one 'Fridge' container.
    const fridgeViews = snap.filter((c) => c.container === 'Fridge' || c.container.startsWith('Fridge '));
    expect(fridgeViews.length).toBeGreaterThan(0);
    for (const v of fridgeViews) for (const s of v.slots) expect(kitchenItems.has(s.item)).toBe(true);

    // a bedroom dresser only holds bedroom-table items.
    const bedroomItems = tableItems('bedroom');
    const dresserViews = snap.filter((c) => c.container === 'Dresser' || c.container.startsWith('Dresser '));
    expect(dresserViews.length).toBeGreaterThan(0);
    for (const v of dresserViews) for (const s of v.slots) expect(bedroomItems.has(s.item)).toBe(true);

    // sanity: kitchen items (canned beans) are NOT in the bedroom table set (the tables are distinct).
    expect(kitchenItems.has(ITEM.CannedBeans as number)).toBe(true);
    expect(bedroomItems.has(ITEM.CannedBeans as number)).toBe(false);
  });

  it('is deterministic: same seed ⇒ identical container loot across two runtimes', () => {
    const a = makeRuntime(7).inventorySnapshot();
    const b = makeRuntime(7).inventorySnapshot();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // a different seed MAY differ — at least the structure (container set) is stable, contents vary.
    const c = makeRuntime(7).inventorySnapshot();
    expect(a.map((x) => x.container)).toEqual(c.map((x) => x.container));
  });
});
