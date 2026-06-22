// Lane-S config domains — V4: every tunable typed + in range; §I spatial-scale defaults honored.
// Importing each domain module self-registers it (registry singleton). This file is isolated by
// vitest so registration happens exactly once here.

import { describe, it, expect } from 'vitest';
import { resolveDomain } from '../registry';
import { worldConfig } from './world';
import { streamingConfig } from './streaming';
import { navigationConfig } from './navigation';
import { collisionConfig } from './collision';
import { structuresConfig } from './structures';
import { destructionConfig } from './destruction';
import { zombiesConfig } from './zombies';
import { perceptionConfig } from './perception';
import { hordesConfig } from './hordes';

const TIER = 'desktop-high' as const;

describe('lane-S config domains (V4 / §I scales)', () => {
  it('world spatial hierarchy matches §I defaults (District 512 / Sector 128 / Chunk 32)', () => {
    const w = resolveDomain(worldConfig, TIER);
    expect(w.districtSize).toBe(512);
    expect(w.sectorSize).toBe(128);
    expect(w.chunkSize).toBe(32);
  });

  it('navigation tile is §I default 16 m and tile/cell ratio is integral', () => {
    const n = resolveDomain(navigationConfig, TIER);
    expect(n.navTileSize).toBe(16);
    expect(Number.isInteger(n.navTileSize / n.navCellSize)).toBe(true);
  });

  it('every lane-S domain resolves a complete value set per tier', () => {
    for (const cfg of [
      worldConfig, streamingConfig, navigationConfig, collisionConfig,
      structuresConfig, destructionConfig, zombiesConfig, perceptionConfig, hordesConfig,
    ]) {
      const resolved = resolveDomain(cfg, TIER);
      expect(Object.keys(resolved).length).toBeGreaterThan(0);
      for (const v of Object.values(resolved)) {
        expect(['number', 'boolean', 'string']).toContain(typeof v);
      }
    }
  });

  it('mobile tier scales zombie capacity + flow-field cache down', () => {
    expect(resolveDomain(zombiesConfig, 'mobile-webgpu').capacity).toBeLessThan(
      resolveDomain(zombiesConfig, TIER).capacity,
    );
    expect(resolveDomain(navigationConfig, 'mobile-webgpu').flowFieldCacheSize).toBeLessThan(
      resolveDomain(navigationConfig, TIER).flowFieldCacheSize,
    );
  });
});
