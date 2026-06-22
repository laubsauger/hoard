// T30 / V2 / V13 — render-tier -> path selection, variation composition, shared material families.

import { describe, it, expect } from 'vitest';
import {
  RENDER_PATHS,
  MATERIAL_FAMILIES,
  selectRenderPath,
  composeVariation,
  resolveCrowdPathSettings,
  CrowdMaterialLibrary,
  type CrowdPathSettings,
} from './paths';
import { ResourceRegistry } from '../engine/resources';

const settings: CrowdPathSettings = resolveCrowdPathSettings('desktop-high');

describe('selectRenderPath (T30 render-tier -> path, V13/V2)', () => {
  it('maps each render tier to its base path at zero distance with a free hero slot', () => {
    expect(selectRenderPath({ renderTier: 0, distanceMeters: 0, heroSlotAvailable: true }, settings)).toBe('hero');
    expect(selectRenderPath({ renderTier: 1, distanceMeters: 0, heroSlotAvailable: true }, settings)).toBe('instanced');
    expect(selectRenderPath({ renderTier: 2, distanceMeters: 0, heroSlotAvailable: true }, settings)).toBe('hordeLod');
    expect(selectRenderPath({ renderTier: 3, distanceMeters: 0, heroSlotAvailable: true }, settings)).toBe('impostor');
  });

  it('clamps render tiers beyond the path table to the far impostor path', () => {
    expect(selectRenderPath({ renderTier: 9, distanceMeters: 0, heroSlotAvailable: true }, settings)).toBe('impostor');
  });

  it('degrades a hero with no available slot to the instanced path (budget enforced, V2)', () => {
    expect(selectRenderPath({ renderTier: 0, distanceMeters: 0, heroSlotAvailable: false }, settings)).toBe('instanced');
  });

  it('only DEGRADES with distance, never upgrades', () => {
    // A tier-0 hero far away falls all the way to impostor.
    const far = settings.hordeLodMaxDistance + 1;
    expect(selectRenderPath({ renderTier: 0, distanceMeters: far, heroSlotAvailable: true }, settings)).toBe('impostor');
    // A tier-3 abstract zombie up close stays impostor (never promoted to hero).
    expect(selectRenderPath({ renderTier: 3, distanceMeters: 0, heroSlotAvailable: true }, settings)).toBe('impostor');
  });

  it('steps hero -> instanced -> hordeLod -> impostor across the distance bands', () => {
    const mk = (d: number) => selectRenderPath({ renderTier: 0, distanceMeters: d, heroSlotAvailable: true }, settings);
    expect(mk(settings.heroMaxDistance)).toBe('hero');
    expect(mk(settings.heroMaxDistance + 0.1)).toBe('instanced');
    expect(mk(settings.instancedMaxDistance + 0.1)).toBe('hordeLod');
    expect(mk(settings.hordeLodMaxDistance + 0.1)).toBe('impostor');
  });

  it('rejects invalid input (V4 — no silent fallback)', () => {
    expect(() => selectRenderPath({ renderTier: -1, distanceMeters: 0, heroSlotAvailable: true }, settings)).toThrow();
    expect(() => selectRenderPath({ renderTier: 0, distanceMeters: -5, heroSlotAvailable: true }, settings)).toThrow();
  });
});

describe('composeVariation (T30 per-instance diversity without per-zombie material, V2)', () => {
  it('is deterministic for the same slot+archetype (V26)', () => {
    const a = composeVariation(42, 1, settings);
    const b = composeVariation(42, 1, settings);
    expect(a).toEqual(b);
  });

  it('keeps every module index within its configured count (no out-of-bounds atlas reads, V4)', () => {
    for (let slot = 0; slot < 200; slot++) {
      const v = composeVariation(slot, slot % 5, settings);
      expect(v.bodyVariant).toBeGreaterThanOrEqual(0);
      expect(v.bodyVariant).toBeLessThan(settings.bodyVariants);
      expect(v.headVariant).toBeLessThan(settings.headVariants);
      expect(v.hairVariant).toBeLessThan(settings.hairVariants);
      expect(v.clothingVariant).toBeLessThan(settings.clothingVariants);
      expect(v.palette).toBeLessThan(settings.paletteCount);
      expect(v.materialFamily).toBeLessThan(settings.materialFamilyCount);
      expect(v.dirt).toBeGreaterThanOrEqual(0);
      expect(v.dirt).toBeLessThanOrEqual(1);
    }
  });

  it('produces diversity across slots (not all identical)', () => {
    const seen = new Set<string>();
    for (let slot = 0; slot < 64; slot++) {
      const v = composeVariation(slot, 0, settings);
      seen.add(`${v.bodyVariant}-${v.headVariant}-${v.clothingVariant}-${v.palette}`);
    }
    expect(seen.size).toBeGreaterThan(8);
  });
});

describe('CrowdMaterialLibrary (V2 shared families, V24 disposal)', () => {
  it('creates ONE material per family (never per zombie) and tracks every resource for disposal', () => {
    const registry = new ResourceRegistry();
    const lib = new CrowdMaterialLibrary(settings, registry);
    const familyCount = Math.min(settings.materialFamilyCount, MATERIAL_FAMILIES.length);
    expect(lib.families.size).toBe(familyCount);
    // families + impostor geometry + impostor material are all registered.
    expect(registry.size).toBe(familyCount + 2);

    const batch = lib.makeImpostorBatch(500, registry);
    expect(batch.count).toBe(0);
    expect(registry.size).toBe(familyCount + 3);

    // The whole far horde shares the SINGLE impostor material (V2).
    expect(lib.materialFor('impostor', 'flesh')).toBe(lib.impostorMaterial);

    registry.disposeAll();
    expect(() => registry.assertNoLeaks()).not.toThrow();
    expect(registry.size).toBe(0);
  });

  it('exposes exactly four ordered render paths', () => {
    expect([...RENDER_PATHS]).toEqual(['hero', 'instanced', 'hordeLod', 'impostor']);
  });
});
