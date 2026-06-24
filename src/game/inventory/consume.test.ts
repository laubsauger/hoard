// T138 — consumable effect resolver: food→eat, water→drink, medical→treat; non-consumables → null.
import { describe, it, expect } from 'vitest';
import { consumeEffect, isConsumable } from './consume';
import { ITEM } from './catalog';

describe('consumeEffect (T138)', () => {
  it('maps food→eat, water→drink, medical→treat; weapons/tools → null', () => {
    expect(consumeEffect(ITEM.CannedBeans)?.kind).toBe('eat');
    expect(consumeEffect(ITEM.Chips)?.kind).toBe('eat');
    expect(consumeEffect(ITEM.WaterBottle)?.kind).toBe('drink');
    expect(consumeEffect(ITEM.Bandage)?.kind).toBe('treat');
    expect(consumeEffect(ITEM.Antibiotics)?.kind).toBe('treat');
    expect(consumeEffect(ITEM.Pistol)).toBeNull();
    expect(consumeEffect(ITEM.Hammer)).toBeNull();
    expect(consumeEffect(ITEM.WoodPlank)).toBeNull();
    expect(isConsumable(ITEM.WaterBottle)).toBe(true);
    expect(isConsumable(ITEM.KitchenKnife)).toBe(false);
  });

  it('every consumable amount is a sane 0..1 delta', () => {
    for (const id of [ITEM.CannedBeans, ITEM.Chips, ITEM.CandyBar, ITEM.WaterBottle, ITEM.Bandage, ITEM.Splint, ITEM.Antibiotics, ITEM.Painkillers]) {
      const e = consumeEffect(id)!;
      expect(e.amount).toBeGreaterThan(0);
      expect(e.amount).toBeLessThanOrEqual(1);
    }
  });
});
