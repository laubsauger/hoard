// T23 tests — V1: transfers run through validated commands (never direct array mutation); weight +
// capacity + category rules + quick-access slot limit are enforced; failures carry an explicit reason;
// timing cost depends on access class; equip routes an item into a slot; encumbrance is derived.

import { describe, it, expect } from 'vitest';
import { InventorySystem } from './inventory';
import { ItemCatalog } from './items';
import { IdFactory } from '@/game/core/ids';
import type { Command, CommandId, ContainerRef, EntityId, EventId, ItemId, WorldEvent } from '@/game/core/contracts';

const PLAYER = 1 as EntityId;

function setup() {
  const catalog = new ItemCatalog();
  const can = catalog.define({ id: 10 as ItemId, name: 'canned food', category: 'food', weightKg: 0.5, stackable: true, maxStack: 12 }).id;
  const brick = catalog.define({ id: 11 as ItemId, name: 'concrete brick', category: 'material', weightKg: 8, stackable: true, maxStack: 5 }).id;
  const pistol = catalog.define({ id: 12 as ItemId, name: 'pistol', category: 'weapon', weightKg: 1, stackable: false }).id;
  const ids = new IdFactory();
  const events: WorldEvent[] = [];
  const inv = new InventorySystem({ catalog, nextEventId: () => ids.next<EventId>('event'), emit: (e) => events.push(e) });

  const backpack: ContainerRef = { entity: PLAYER, container: 'backpack' };
  const vest: ContainerRef = { entity: PLAYER, container: 'vest' }; // quick-access clothing
  const crate: ContainerRef = { entity: 99 as EntityId, container: 'crate' };
  inv.addContainer(backpack, { type: 'backpack', capacityKg: 20 });
  inv.addContainer(vest, { type: 'clothing', capacityKg: 10 });
  inv.addContainer(crate, { type: 'crate', capacityKg: 50, allowedCategories: ['material', 'food'] });
  return { inv, ids, events, can, brick, pistol, backpack, vest, crate };
}

let cmdSeq = 0;
function moveCmd(item: ItemId, from: ContainerRef, to: ContainerRef, count: number): Command {
  return { kind: 'moveItem', id: (cmdSeq++) as CommandId, item, from, to, count };
}

describe('inventory — capacity + weight (V1)', () => {
  it('rejects a transfer that would exceed destination weight capacity, with a reason', () => {
    const { inv, crate, backpack, brick } = setup();
    inv.seed(crate, brick, 3); // 24kg in a 50kg crate
    // backpack capacity 20kg; moving 3 bricks (24kg) overflows it.
    const out = inv.apply(moveCmd(brick, crate, backpack, 3));
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) expect(out.result.reason).toBe('over-capacity');
    // nothing moved — source intact, dest empty.
    expect(inv.count(crate, brick)).toBe(3);
    expect(inv.count(backpack, brick)).toBe(0);
  });

  it('a valid transfer moves items, emits itemMoved, and reports a timing cost', () => {
    const { inv, events, crate, backpack, can } = setup();
    inv.seed(crate, can, 10);
    const out = inv.apply(moveCmd(can, crate, backpack, 4));
    expect(out.result.ok).toBe(true);
    expect(inv.count(crate, can)).toBe(6);
    expect(inv.count(backpack, can)).toBe(4);
    expect(out.seconds).toBeGreaterThan(0); // backpack is deep storage -> slow
    expect(events.some((e) => e.kind === 'itemMoved')).toBe(true);
  });

  it('quick-access retrieval is faster than digging in a backpack', () => {
    const { inv, crate, vest, backpack, can } = setup();
    inv.seed(crate, can, 4);
    const toVest = inv.apply(moveCmd(can, crate, vest, 1));
    const toPack = inv.apply(moveCmd(can, crate, backpack, 1));
    expect(toVest.result.ok && toPack.result.ok).toBe(true);
    expect(toVest.seconds).toBeLessThan(toPack.seconds);
  });
});

describe('inventory — category + stack + slot rules', () => {
  it('rejects a category the container disallows', () => {
    const { inv, crate, backpack, pistol } = setup();
    inv.seed(backpack, pistol, 1);
    const out = inv.apply(moveCmd(pistol, backpack, crate, 1)); // crate allows only material/food
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) expect(out.result.reason).toBe('category-rejected');
  });

  it('rejects exceeding a stack limit', () => {
    const { inv, crate, backpack, brick } = setup();
    inv.seed(crate, brick, 5);
    inv.seed(backpack, brick, 1); // brick maxStack 5; backpack already has 1
    const out = inv.apply(moveCmd(brick, crate, backpack, 5)); // 1+5 = 6 > 5
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) expect(out.result.reason).toBe('stack-overflow');
  });

  it('rejects insufficient quantity at the source', () => {
    const { inv, crate, backpack, can } = setup();
    inv.seed(crate, can, 2);
    const out = inv.apply(moveCmd(can, crate, backpack, 5));
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) expect(out.result.reason).toBe('insufficient-quantity');
  });

  it('enforces the quick-access slot limit (distinct stacks)', () => {
    const catalog = new ItemCatalog();
    const ids = new IdFactory();
    const inv = new InventorySystem({ catalog, nextEventId: () => ids.next<EventId>('event'), tier: 'desktop-high' });
    const src: ContainerRef = { entity: PLAYER, container: 'crate' };
    const vest: ContainerRef = { entity: PLAYER, container: 'vest' };
    inv.addContainer(src, { type: 'crate', capacityKg: 100 });
    inv.addContainer(vest, { type: 'clothing', capacityKg: 100 }); // quick-access, 4 slots default
    // define 5 distinct light items and fill all 4 quick-access slots, then overflow.
    for (let i = 0; i < 5; i++) {
      const id = catalog.define({ id: (50 + i) as ItemId, name: `gadget${i}`, category: 'misc', weightKg: 0.1, stackable: false }).id;
      inv.seed(src, id, 1);
      const out = inv.apply(moveCmd(id, src, vest, 1));
      if (i < 4) expect(out.result.ok).toBe(true);
      else {
        expect(out.result.ok).toBe(false);
        if (!out.result.ok) expect(out.result.reason).toBe('slot-full');
      }
    }
  });
});

describe('inventory — equip + encumbrance', () => {
  it('equip moves a held item into a slot; fails clearly if not held', () => {
    const { inv, backpack, pistol } = setup();
    const holster: ContainerRef = { entity: PLAYER, container: 'holster' };
    inv.addContainer(holster, { type: 'clothing', capacityKg: 5, allowedCategories: ['weapon'] });
    const notHeld: Command = { kind: 'equip', id: (cmdSeq++) as CommandId, entity: PLAYER, item: pistol, slot: 'holster' };
    expect(inv.apply(notHeld).result.ok).toBe(false);
    inv.seed(backpack, pistol, 1);
    const ok: Command = { kind: 'equip', id: (cmdSeq++) as CommandId, entity: PLAYER, item: pistol, slot: 'holster' };
    expect(inv.apply(ok).result.ok).toBe(true);
    expect(inv.count(holster, pistol)).toBe(1);
  });

  it('encumbrance is derived from total carried weight', () => {
    const { inv, backpack, brick } = setup();
    inv.seed(backpack, brick, 2); // 16kg, default encumbranceFull 30kg
    const e = inv.encumbrance(PLAYER);
    expect(e).toBeCloseTo(16 / 30);
    expect(e).toBeGreaterThan(0);
    expect(e).toBeLessThan(1);
  });
});
