// T34 / V7 — automated asset validator.
// V7: no generated asset is accepted without validation + budgets. On ANY failure the validator
// returns explicit structured errors AND a clear placeholder asset (which always carries a collider,
// never a silent missing one). It never invents fallbacks to "pass" invalid content.

import {
  getSkeletonFamily,
  meters,
  raw,
  type AssetContract,
  type CollisionContract,
  type EnvironmentAssetContract,
  type LodLevel,
  type ZombieAssetContract,
} from '@/assets';
import type { AssetBudgets } from './budgets';

export type ValidationCode =
  | 'unknown-skeleton-family'
  | 'missing-skeleton-bone'
  | 'unapproved-skeleton-bone'
  | 'invalid-bind-pose'
  | 'region-bone-not-in-rig'
  | 'missing-wound-cap'
  | 'missing-detached-part'
  | 'missing-collision-proxy'
  | 'missing-lod'
  | 'triangle-budget-exceeded'
  | 'performance-metadata-mismatch'
  | 'texture-memory-budget-exceeded'
  | 'material-count-exceeded'
  | 'bone-budget-exceeded'
  | 'missing-fracture-mapping'
  | 'missing-collision-state';

export interface ValidationError {
  readonly code: ValidationCode;
  /** The specific subject of the failure (bone name, LOD level, region id, …). */
  readonly subject: string;
  readonly message: string;
}

/**
 * V7 placeholder: a clear stand-in shown when an asset fails validation. It ALWAYS has a collider so
 * gameplay never silently loses collision. `isPlaceholder` lets render/debug flag it loudly.
 */
export interface PlaceholderAsset {
  readonly isPlaceholder: true;
  readonly forAssetId: string;
  readonly reason: string;
  readonly geometryRef: string;
  readonly collision: CollisionContract;
}

export interface ValidationReport {
  readonly assetId: string;
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
  /** Non-null exactly when `ok` is false (V7). */
  readonly placeholder: PlaceholderAsset | null;
}

// Known placeholder collider dimensions — a deliberately obvious humanoid-sized capsule.
const PLACEHOLDER_FOOTPRINT_RADIUS_M = 0.5;
const PLACEHOLDER_CAPSULE_RADIUS_M = 0.4;
const PLACEHOLDER_CAPSULE_HEIGHT_M = 1.9;
const PLACEHOLDER_GEOMETRY_REF = 'builtin://placeholder/capsule';

function makePlaceholder(assetId: string, errors: readonly ValidationError[]): PlaceholderAsset {
  return {
    isPlaceholder: true,
    forAssetId: assetId,
    reason: `asset '${assetId}' failed validation (${errors.length} error(s)): ${errors
      .map((e) => e.code)
      .join(', ')}`,
    geometryRef: PLACEHOLDER_GEOMETRY_REF,
    collision: {
      groundFootprintRadiusM: meters(PLACEHOLDER_FOOTPRINT_RADIUS_M),
      bodyCapsule: {
        radiusM: meters(PLACEHOLDER_CAPSULE_RADIUS_M),
        heightM: meters(PLACEHOLDER_CAPSULE_HEIGHT_M),
      },
      anatomicalProxies: [],
    },
  };
}

// ---- Shared checks ----

function checkLods(descriptor: AssetContract, budgets: AssetBudgets, errors: ValidationError[]): void {
  const byLevel = new Map<LodLevel, number>();
  for (const entry of descriptor.lods.levels) {
    byLevel.set(entry.level, raw(entry.triangles));
  }

  for (const level of budgets.requiredLods) {
    if (!byLevel.has(level)) {
      errors.push({
        code: 'missing-lod',
        subject: level,
        message: `required LOD '${level}' is missing from the LOD chain`,
      });
    }
  }

  for (const entry of descriptor.lods.levels) {
    const max = raw(budgets.maxTrianglesByLod[entry.level]);
    const actual = raw(entry.triangles);
    if (actual > max) {
      errors.push({
        code: 'triangle-budget-exceeded',
        subject: entry.level,
        message: `LOD '${entry.level}' has ${actual} triangles, budget is ${max}`,
      });
    }
    // Performance metadata must agree with the actual LOD geometry.
    const declared = raw(descriptor.performance.trianglesByLod[entry.level]);
    if (declared !== actual) {
      errors.push({
        code: 'performance-metadata-mismatch',
        subject: entry.level,
        message: `performance metadata declares ${declared} triangles for '${entry.level}' but LOD has ${actual}`,
      });
    }
  }
}

function checkTextures(descriptor: AssetContract, budgets: AssetBudgets, errors: ValidationError[]): void {
  let total = 0;
  for (const tex of descriptor.textures.textures) {
    total += raw(tex.memoryBytes);
  }
  const max = raw(budgets.maxTextureMemoryBytes);
  if (total > max) {
    errors.push({
      code: 'texture-memory-budget-exceeded',
      subject: descriptor.id,
      message: `texture memory ${total} bytes exceeds budget ${max} bytes`,
    });
  }
}

function checkMaterials(descriptor: AssetContract, budgets: AssetBudgets, errors: ValidationError[]): void {
  const slots = descriptor.material.materialSlots.length;
  const max = raw(budgets.maxMaterialSlots);
  if (slots > max) {
    errors.push({
      code: 'material-count-exceeded',
      subject: descriptor.material.familyId,
      message: `material family '${descriptor.material.familyId}' uses ${slots} slots, budget is ${max}`,
    });
  }
}

// ---- Zombie checks ----

function checkZombie(descriptor: ZombieAssetContract, budgets: AssetBudgets, errors: ValidationError[]): void {
  const family = getSkeletonFamily(descriptor.skeleton.familyId);
  const rigBones = new Set(descriptor.skeleton.bones);

  if (!family) {
    errors.push({
      code: 'unknown-skeleton-family',
      subject: descriptor.skeleton.familyId,
      message: `skeleton family '${descriptor.skeleton.familyId}' is not registered`,
    });
  } else {
    const approved = new Set(family.approvedBones);
    for (const required of family.requiredBones) {
      if (!rigBones.has(required)) {
        errors.push({
          code: 'missing-skeleton-bone',
          subject: required,
          message: `required bone '${required}' is missing from rig (family '${family.id}')`,
        });
      }
    }
    for (const bone of descriptor.skeleton.bones) {
      if (!approved.has(bone)) {
        errors.push({
          code: 'unapproved-skeleton-bone',
          subject: bone,
          message: `bone '${bone}' is not approved for family '${family.id}'`,
        });
      }
    }
    for (const required of family.requiredBones) {
      if (rigBones.has(required) && descriptor.skeleton.bindPose[required] === undefined) {
        errors.push({
          code: 'invalid-bind-pose',
          subject: required,
          message: `bind pose has no transform for required bone '${required}'`,
        });
      }
    }
  }

  // Bone budget.
  const declaredBones = raw(descriptor.performance.boneCount);
  const maxBones = raw(budgets.maxBones);
  if (declaredBones > maxBones) {
    errors.push({
      code: 'bone-budget-exceeded',
      subject: descriptor.id,
      message: `${declaredBones} bones exceeds budget ${maxBones}`,
    });
  }

  // Regions: bone ownership must be in the rig; detachable regions need wound caps, detached parts,
  // and a collision proxy (V7 / V17 — never a silent missing collider).
  const proxyRegions = new Set(descriptor.collision.anatomicalProxies.map((p) => p.regionId));
  for (const region of descriptor.regions) {
    for (const bone of region.bones) {
      if (!rigBones.has(bone)) {
        errors.push({
          code: 'region-bone-not-in-rig',
          subject: `${region.id}:${bone}`,
          message: `region '${region.id}' owns bone '${bone}' which is not in the rig`,
        });
      }
    }
    if (region.detachable) {
      if (region.woundCapRef === null) {
        errors.push({
          code: 'missing-wound-cap',
          subject: region.id,
          message: `detachable region '${region.id}' has no wound-cap geometry`,
        });
      }
      if (region.detachedPartRef === null) {
        errors.push({
          code: 'missing-detached-part',
          subject: region.id,
          message: `detachable region '${region.id}' has no detached-part asset`,
        });
      }
      if (!proxyRegions.has(region.id)) {
        errors.push({
          code: 'missing-collision-proxy',
          subject: region.id,
          message: `detachable region '${region.id}' has no anatomical collision proxy`,
        });
      }
    }
  }
}

// ---- Environment checks ----

function checkEnvironment(
  descriptor: EnvironmentAssetContract,
  _budgets: AssetBudgets,
  errors: ValidationError[],
): void {
  const mappedCells = new Set(descriptor.structuralMapping.cellIds);
  for (const family of descriptor.fractureFamilies) {
    if (family.structuralCellIds.length === 0) {
      errors.push({
        code: 'missing-fracture-mapping',
        subject: family.id,
        message: `fracture family '${family.id}' maps to no structural cells`,
      });
      continue;
    }
    for (const cell of family.structuralCellIds) {
      if (!mappedCells.has(cell)) {
        errors.push({
          code: 'missing-fracture-mapping',
          subject: `${family.id}:${cell}`,
          message: `fracture family '${family.id}' references cell '${cell}' not in module '${descriptor.structuralMapping.moduleId}'`,
        });
      }
    }
  }

  const states = new Set(descriptor.collisionStates.map((s) => s.state));
  if (!states.has('intact')) {
    errors.push({
      code: 'missing-collision-state',
      subject: descriptor.id,
      message: `environment asset '${descriptor.id}' has no 'intact' collision state`,
    });
  }
}

/** Validate any asset descriptor against typed budgets. Returns structured errors + a placeholder. */
export function validateAsset(descriptor: AssetContract, budgets: AssetBudgets): ValidationReport {
  const errors: ValidationError[] = [];

  checkLods(descriptor, budgets, errors);
  checkTextures(descriptor, budgets, errors);
  checkMaterials(descriptor, budgets, errors);

  switch (descriptor.kind) {
    case 'zombie':
      checkZombie(descriptor, budgets, errors);
      break;
    case 'environment':
      checkEnvironment(descriptor, budgets, errors);
      break;
  }

  const ok = errors.length === 0;
  return {
    assetId: descriptor.id,
    ok,
    errors,
    placeholder: ok ? null : makePlaceholder(descriptor.id, errors),
  };
}
