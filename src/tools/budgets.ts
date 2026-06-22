// T34 / V4 / V7 — explicit, typed asset budgets.
// These are NOT magic numbers: each is a named, documented, unit-typed contract field with a stated
// rationale. The validator compares a descriptor against the appropriate budget for its kind.

import {
  boneCount,
  bytes,
  count,
  triangles,
  type BoneCount,
  type Bytes,
  type Count,
  type LodLevel,
  type Triangles,
} from '@/assets';

export interface AssetBudgets {
  /** Max triangles allowed per LOD level. */
  readonly maxTrianglesByLod: Readonly<Record<LodLevel, Triangles>>;
  /** LOD levels that MUST be present for this asset kind. */
  readonly requiredLods: readonly LodLevel[];
  /** Max total texture memory across all delivered textures. */
  readonly maxTextureMemoryBytes: Bytes;
  /** Max material slots (keeps draw-group / batching cost bounded). */
  readonly maxMaterialSlots: Count;
  /** Max skeleton bones (skinning cost). 0 for non-skinned assets. */
  readonly maxBones: BoneCount;
}

const MEBIBYTE = 1024 * 1024;

/**
 * Zombie budget — must support hundreds of instanced bodies (§V perf gates: 300–800 visible).
 * Triangle ceilings drop sharply per LOD so the horde/impostor tiers stay cheap.
 */
export const DEFAULT_ZOMBIE_BUDGETS: AssetBudgets = {
  maxTrianglesByLod: {
    hero: triangles(45_000),
    crowd: triangles(12_000),
    horde: triangles(3_000),
    impostor: triangles(200),
  },
  requiredLods: ['hero', 'crowd', 'horde', 'impostor'],
  maxTextureMemoryBytes: bytes(24 * MEBIBYTE),
  maxMaterialSlots: count(4),
  maxBones: boneCount(72),
};

/**
 * Environment budget — static destructible structures. Higher tri ceilings (single instances) but
 * no skeleton. Impostor not required (structures rarely render as billboards at horde distance).
 */
export const DEFAULT_ENVIRONMENT_BUDGETS: AssetBudgets = {
  maxTrianglesByLod: {
    hero: triangles(120_000),
    crowd: triangles(40_000),
    horde: triangles(8_000),
    impostor: triangles(500),
  },
  requiredLods: ['hero', 'crowd', 'horde'],
  maxTextureMemoryBytes: bytes(64 * MEBIBYTE),
  maxMaterialSlots: count(8),
  maxBones: boneCount(0),
};

/** Pick the default budget for an asset kind. */
export function defaultBudgetsFor(kind: 'zombie' | 'environment'): AssetBudgets {
  return kind === 'zombie' ? DEFAULT_ZOMBIE_BUDGETS : DEFAULT_ENVIRONMENT_BUDGETS;
}
