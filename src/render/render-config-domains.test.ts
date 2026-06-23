// T29/T31/T32 — verify the render config domains (lighting/shadows/materials/postFX) self-register
// and validate (V4), and that key tunables resolve with sane per-tier scaling (V22/V25).

import { describe, it, expect } from 'vitest';
import { resolve } from '../config/spec';
import { validateAll, registeredDomains } from '../config/registry';
import { lightingConfig } from '../config/domains/lighting';
import { shadowsConfig } from '../config/domains/shadows';
import { materialsConfig } from '../config/domains/materials';
import { postFXConfig } from '../config/domains/postFX';
import { renderingConfig } from '../config/domains/rendering';

describe('render config domains (V4)', () => {
  it('register without throwing and pass validateAll', () => {
    const domains = registeredDomains();
    for (const d of ['lighting', 'shadows', 'materials', 'postFX', 'rendering']) {
      expect(domains).toContain(d);
    }
    expect(() => validateAll()).not.toThrow();
  });

  it('scales shadow + light budgets down on lower tiers (V22)', () => {
    expect(resolve(shadowsConfig.cascadeCount, 'desktop-high')).toBeGreaterThanOrEqual(resolve(shadowsConfig.cascadeCount, 'mobile-webgpu'));
    expect(resolve(shadowsConfig.shadowMapResolution, 'desktop-high')).toBeGreaterThan(resolve(shadowsConfig.shadowMapResolution, 'mobile-webgpu'));
    expect(resolve(lightingConfig.localLightBudget, 'desktop-high')).toBeGreaterThan(resolve(lightingConfig.localLightBudget, 'mobile-webgpu'));
  });

  it('keeps dynamic-resolution floor in (0,1] and engage threshold below 1 (engages before failure, V22)', () => {
    const floor = resolve(postFXConfig.dynamicResolutionFloor, 'desktop-high');
    expect(floor).toBeGreaterThan(0);
    expect(floor).toBeLessThanOrEqual(1);
    expect(resolve(postFXConfig.gpuPressureEngageThreshold, 'desktop-high')).toBeLessThan(1);
  });

  it('orders crowd render-path distance bands hero < instanced < hordeLod (T30)', () => {
    const hero = resolve(renderingConfig.crowdHeroMaxDistanceMeters, 'desktop-high');
    const inst = resolve(renderingConfig.crowdInstancedMaxDistanceMeters, 'desktop-high');
    const horde = resolve(renderingConfig.crowdHordeLodMaxDistanceMeters, 'desktop-high');
    expect(hero).toBeLessThan(inst);
    expect(inst).toBeLessThan(horde);
  });

  it('keeps the player outline at least as wide as threat outlines (T32)', () => {
    expect(resolve(materialsConfig.outlineWidthPlayerPx, 'desktop-high')).toBeGreaterThanOrEqual(
      resolve(materialsConfig.outlineWidthThreatPx, 'desktop-high'),
    );
  });

  it('preserves wall base height below the upper-wall fade start (T28/V20)', () => {
    expect(resolve(renderingConfig.wallBasePreservedHeightMeters, 'desktop-high')).toBeLessThanOrEqual(
      resolve(renderingConfig.upperWallFadeStartHeightMeters, 'desktop-high'),
    );
  });

  it('resolves the directional-cutaway camera-facing threshold as a cosine in [-1,1] (T82/V58)', () => {
    const t = resolve(renderingConfig.cutawayCameraFacingDotThreshold, 'desktop-high');
    expect(t).toBeGreaterThan(-1);
    expect(t).toBeLessThan(1);
  });

  it('scales the directional shadow ortho frustum + map down on lower tiers (T45/V36/V8)', () => {
    // smaller frustum + map on mobile → sharper-for-cost + cheaper budget per tier (V8/V22)
    expect(resolve(shadowsConfig.shadowOrthoHalfExtentMeters, 'desktop-high')).toBeGreaterThan(
      resolve(shadowsConfig.shadowOrthoHalfExtentMeters, 'mobile-webgpu'),
    );
    expect(resolve(shadowsConfig.shadowMaxDistanceMeters, 'desktop-high')).toBeGreaterThan(
      resolve(shadowsConfig.shadowMaxDistanceMeters, 'mobile-webgpu'),
    );
    // the shadow camera far must clear the light distance so nothing between light + scene is clipped
    for (const tier of ['desktop-high', 'mobile-webgpu'] as const) {
      const far = resolve(shadowsConfig.shadowLightDistanceMeters, tier) + resolve(shadowsConfig.shadowMaxDistanceMeters, tier);
      expect(far).toBeGreaterThan(resolve(shadowsConfig.shadowLightDistanceMeters, tier));
    }
  });

  it('resolves contact-AO strength per tier (stronger on high) + a non-negative ground lift (T45/V36)', () => {
    expect(resolve(lightingConfig.ambientOcclusionStrength, 'desktop-high')).toBeGreaterThanOrEqual(
      resolve(lightingConfig.ambientOcclusionStrength, 'mobile-webgpu'),
    );
    expect(resolve(lightingConfig.contactAoRadiusMeters, 'desktop-high')).toBeGreaterThan(0);
    expect(resolve(lightingConfig.contactAoGroundLiftMeters, 'desktop-high')).toBeGreaterThanOrEqual(0);
  });
});
