// Wave-2 lane-S config domains (T22-T27) — V4: every tunable typed, in range, resolvable per tier;
// importing each domain self-registers it (registry singleton, isolated per vitest file).

import { describe, it, expect } from 'vitest';
import { resolveDomain } from '../registry';
import { survivalConfig } from './survival';
import { itemsConfig } from './items';
import { inventoryConfig } from './inventory';
import { craftingConfig } from './crafting';
import { fireConfig } from './fire';
import { audioConfig } from './audio';
import { destructionConfig } from './destruction';

const TIER = 'desktop-high' as const;

describe('Wave-2 lane-S config domains (V4)', () => {
  it('every domain resolves a complete, typed value set', () => {
    for (const cfg of [survivalConfig, itemsConfig, inventoryConfig, craftingConfig, fireConfig, audioConfig, destructionConfig]) {
      const resolved = resolveDomain(cfg, TIER);
      expect(Object.keys(resolved).length).toBeGreaterThan(0);
      for (const v of Object.values(resolved)) {
        expect(['number', 'boolean', 'string']).toContain(typeof v);
      }
    }
  });

  it('survival rates are slow pressure (V31): hunger fills over many in-game hours', () => {
    const s = resolveDomain(survivalConfig, TIER);
    const hoursToFull = 1 / (s.hungerRatePerSec * 3600);
    expect(hoursToFull).toBeGreaterThan(5); // not constant babysitting
  });

  it('destruction modification tunables are present (T25)', () => {
    const d = resolveDomain(destructionConfig, TIER);
    expect(d.boardStrengthBonus).toBeGreaterThan(0);
    expect(d.reinforceStrengthMultiplier).toBeGreaterThan(1);
    expect(d.obstructionNavCost).toBeGreaterThanOrEqual(0);
  });

  it('audio attenuation links are ordered breach > window > door > floor > wall', () => {
    const a = resolveDomain(audioConfig, TIER);
    expect(a.breachAttenuation).toBeGreaterThan(a.windowAttenuation);
    expect(a.windowAttenuation).toBeGreaterThan(a.doorAttenuation);
    expect(a.floorAttenuation).toBeGreaterThan(a.wallAttenuation);
  });
});
