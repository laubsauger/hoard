// T30 / V2 / V8 — crowd render paths + per-instance variation composition.
// FOUR paths: hero skinned mesh / instanced animated crowd / horde-LOD / impostor-or-cluster (far).
// Path selection is driven by the authoritative render tier (V13), then DEGRADED (never upgraded) by
// screen distance + the hero budget. NO unique shader/material per zombie (V2): every member shares one
// of a few material families, diversity comes from a composed per-instance variation record.
// This module is pure logic (no GPU). The shared GPU material families live in CrowdMaterialLibrary,
// which tracks every resource in the disposal registry (V24).

import {
  InstancedMesh,
  MeshStandardMaterial,
  PlaneGeometry,
  type Material,
} from 'three';
import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import { variationSeed } from './packing';

/** The four crowd render paths, ordered most -> least expensive. Index = cost rank. */
export const RENDER_PATHS = ['hero', 'instanced', 'hordeLod', 'impostor'] as const;
export type RenderPath = (typeof RENDER_PATHS)[number];

/** Shared material families — a member picks ONE; never a per-zombie material (V2). */
export const MATERIAL_FAMILIES = ['flesh', 'clothing', 'armor', 'burned'] as const;
export type MaterialFamily = (typeof MATERIAL_FAMILIES)[number];

export interface CrowdPathSettings {
  /** Inclusive max distance (m) for each path before it degrades to the next-cheaper one. */
  readonly heroMaxDistance: number;
  readonly instancedMaxDistance: number;
  readonly hordeLodMaxDistance: number;
  readonly heroBudget: number;
  readonly materialFamilyCount: number;
  readonly bodyVariants: number;
  readonly headVariants: number;
  readonly hairVariants: number;
  readonly clothingVariants: number;
  readonly paletteCount: number;
}

export function resolveCrowdPathSettings(tier: QualityTier): CrowdPathSettings {
  return {
    heroMaxDistance: resolve(renderingConfig.crowdHeroMaxDistanceMeters, tier),
    instancedMaxDistance: resolve(renderingConfig.crowdInstancedMaxDistanceMeters, tier),
    hordeLodMaxDistance: resolve(renderingConfig.crowdHordeLodMaxDistanceMeters, tier),
    heroBudget: resolve(renderingConfig.crowdHeroBudget, tier),
    materialFamilyCount: resolve(renderingConfig.crowdMaterialFamilyCount, tier),
    bodyVariants: resolve(renderingConfig.crowdBodyVariantCount, tier),
    headVariants: resolve(renderingConfig.crowdHeadVariantCount, tier),
    hairVariants: resolve(renderingConfig.crowdHairVariantCount, tier),
    clothingVariants: resolve(renderingConfig.crowdClothingVariantCount, tier),
    paletteCount: resolve(renderingConfig.crowdPaletteCount, tier),
  };
}

/** The render-tier byte from the SoA maps directly to a base path (most-expensive intent). */
function basePathForTier(renderTier: number): RenderPath {
  if (!Number.isInteger(renderTier) || renderTier < 0) {
    throw new Error(`renderTier must be a non-negative integer, got ${renderTier}`);
  }
  // 0 hero / 1 active-crowd / 2 visible-horde / 3 abstract (clamped to impostor for anything beyond).
  const idx = Math.min(renderTier, RENDER_PATHS.length - 1);
  return RENDER_PATHS[idx]!;
}

export interface PathSelectionInput {
  /** Authoritative render tier (SoA renderTier byte). */
  readonly renderTier: number;
  /** Screen-space distance from camera in world meters. */
  readonly distanceMeters: number;
  /**
   * Whether a hero slot is still available within the budget. A tier-0 zombie that cannot get a hero
   * slot degrades to the instanced path — the budget is enforced here, never by inventing extra slots.
   */
  readonly heroSlotAvailable: boolean;
}

/**
 * Select a render path. The tier sets the *best* allowed path; distance and hero-budget can only DEGRADE
 * it toward cheaper paths (V22 ordering favors dropping fidelity, never upgrading a distant abstract
 * zombie back to a hero). Returns one of RENDER_PATHS.
 */
export function selectRenderPath(input: PathSelectionInput, settings: CrowdPathSettings): RenderPath {
  const { renderTier, distanceMeters, heroSlotAvailable } = input;
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error(`distanceMeters must be a non-negative finite number, got ${distanceMeters}`);
  }

  let pathIdx = RENDER_PATHS.indexOf(basePathForTier(renderTier));

  // Budget: a hero candidate with no free hero slot degrades one step to instanced.
  if (pathIdx === 0 && !heroSlotAvailable) pathIdx = 1;

  // Distance degradation: push to the cheapest path whose max-distance the member is still within.
  // Each threshold is the inclusive far edge of that path.
  if (distanceMeters > settings.heroMaxDistance && pathIdx < 1) pathIdx = 1;
  if (distanceMeters > settings.instancedMaxDistance && pathIdx < 2) pathIdx = 2;
  if (distanceMeters > settings.hordeLodMaxDistance && pathIdx < 3) pathIdx = 3;

  return RENDER_PATHS[pathIdx]!;
}

/** Composed per-instance visual variation — indices into shared atlases, NOT a new material (V2). */
export interface VariationModules {
  readonly bodyVariant: number;
  readonly headVariant: number;
  readonly hairVariant: number;
  readonly clothingVariant: number;
  readonly palette: number;
  /** Material family this member draws with (one of a few shared materials). */
  readonly materialFamily: number;
  /** 0..1 dirt overlay amount. */
  readonly dirt: number;
  /** 0..1 blood overlay amount (raised by combat events at runtime). */
  readonly blood: number;
  /** Posture variant index (idle/aggressive/wounded lean ...). */
  readonly posture: number;
  /** Uniform scale multiplier band [scaleMin, scaleMax] is applied separately during packing. */
  readonly scaleSeed: number;
  /** Animation phase offset so identical clips do not march in lock-step. */
  readonly animPhaseOffset: number;
}

/** Deterministic small mix so different facets of one slot decorrelate without per-zombie storage. */
function facet(slot: number, salt: number, count: number): number {
  return variationSeed((slot * 2654435761 + salt * 40503) >>> 0, count);
}

/**
 * Compose a stable per-instance variation record from a slot index + archetype. Pure + deterministic
 * (V26): same inputs always yield the same modules, so workers/replay agree. Every index stays within
 * its configured count, so no atlas read ever goes out of bounds (V4).
 */
export function composeVariation(
  slot: number,
  archetype: number,
  settings: CrowdPathSettings,
  postureCount = 4,
): VariationModules {
  if (!Number.isInteger(slot) || slot < 0) throw new Error(`slot must be a non-negative integer, got ${slot}`);
  if (postureCount <= 0) throw new Error(`postureCount must be positive, got ${postureCount}`);
  const a = archetype >>> 0;
  return {
    bodyVariant: facet(slot, 1, settings.bodyVariants),
    headVariant: facet(slot, 2, settings.headVariants),
    hairVariant: facet(slot, 3, settings.hairVariants),
    clothingVariant: facet(slot, 4, settings.clothingVariants),
    palette: facet(slot, 5, settings.paletteCount),
    // Material family is biased by archetype (armored -> armor) but still one of the SHARED few.
    materialFamily: a % settings.materialFamilyCount,
    dirt: facet(slot, 6, 256) / 255,
    blood: 0,
    posture: facet(slot, 7, postureCount),
    scaleSeed: facet(slot, 8, 256) / 255,
    animPhaseOffset: facet(slot, 9, 256) / 256,
  };
}

/**
 * Owns the SHARED crowd material families + per-path placeholder meshes. Construction is CPU-only (no
 * GPU device needed — Three.js materials construct in node, like Crowd does), and EVERY resource is
 * tracked in the disposal registry (V24). There is exactly one material per family => never one per
 * zombie (V2). The impostor path shares a single billboard material across the whole far horde.
 */
export class CrowdMaterialLibrary {
  readonly families: ReadonlyMap<MaterialFamily, MeshStandardMaterial>;
  readonly impostorMaterial: MeshStandardMaterial;
  private readonly impostorGeometry: PlaneGeometry;

  constructor(settings: CrowdPathSettings, registry: ResourceRegistry) {
    const familyCount = Math.min(settings.materialFamilyCount, MATERIAL_FAMILIES.length);
    const map = new Map<MaterialFamily, MeshStandardMaterial>();
    for (let i = 0; i < familyCount; i++) {
      const family = MATERIAL_FAMILIES[i]!;
      const mat = registry.track(
        new MeshStandardMaterial({ name: `crowd.${family}` }),
        'material',
        `crowd.family.${family}`,
      );
      map.set(family, mat);
    }
    this.families = map;

    // Far horde = ONE shared impostor billboard material + geometry (V2 — never per-member).
    this.impostorGeometry = registry.track(new PlaneGeometry(0.6, 1.8), 'geometry', 'crowd.impostor.geometry');
    this.impostorMaterial = registry.track(
      new MeshStandardMaterial({ name: 'crowd.impostor', transparent: true }),
      'material',
      'crowd.impostor.material',
    );
  }

  materialFor(path: RenderPath, family: MaterialFamily): Material {
    if (path === 'impostor') return this.impostorMaterial;
    const mat = this.families.get(family);
    if (!mat) throw new Error(`no shared material for family '${family}' (family count too low)`);
    return mat;
  }

  /** Build a far-horde impostor InstancedMesh using the SINGLE shared impostor material (V2). */
  makeImpostorBatch(capacity: number, registry: ResourceRegistry): InstancedMesh {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error(`capacity must be positive, got ${capacity}`);
    const mesh = new InstancedMesh(this.impostorGeometry, this.impostorMaterial, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    return registry.track(mesh, 'buffer', 'crowd.impostor.batch');
  }
}
