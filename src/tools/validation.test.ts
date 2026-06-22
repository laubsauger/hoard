import { describe, expect, it } from 'vitest';
import { validateAsset, type ValidationCode } from './validation';
import { DEFAULT_ZOMBIE_BUDGETS, DEFAULT_ENVIRONMENT_BUDGETS } from './budgets';
import { makeZombieContract, makeEnvironmentContract } from './fixtures';
import { triangles } from '@/assets';
import type { ZombieAssetContract } from '@/assets';

function codes(report: { errors: readonly { code: ValidationCode }[] }): ValidationCode[] {
  return report.errors.map((e) => e.code);
}

describe('asset validation (T34 / V7)', () => {
  it('accepts a well-formed zombie descriptor with no errors + no placeholder', () => {
    const report = validateAsset(makeZombieContract(), DEFAULT_ZOMBIE_BUDGETS);
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.placeholder).toBeNull();
  });

  it('accepts a well-formed environment descriptor', () => {
    const report = validateAsset(makeEnvironmentContract(), DEFAULT_ENVIRONMENT_BUDGETS);
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
  });

  it('rejects a missing required skeleton bone with an explicit error + placeholder collider (V7)', () => {
    const d = makeZombieContract();
    const broken: ZombieAssetContract = {
      ...d,
      skeleton: { ...d.skeleton, bones: d.skeleton.bones.filter((b) => b !== 'head') },
    };
    const report = validateAsset(broken, DEFAULT_ZOMBIE_BUDGETS);

    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('missing-skeleton-bone');
    // V7: failure produces a placeholder that ALWAYS carries a collider — never silent.
    expect(report.placeholder).not.toBeNull();
    expect(report.placeholder?.isPlaceholder).toBe(true);
    expect(report.placeholder?.collision.bodyCapsule.heightM).toBeDefined();
    expect(report.placeholder?.reason).toContain(d.id);
  });

  it('rejects a missing required LOD', () => {
    const d = makeZombieContract();
    const broken: ZombieAssetContract = {
      ...d,
      lods: { levels: d.lods.levels.filter((l) => l.level !== 'impostor') },
    };
    const report = validateAsset(broken, DEFAULT_ZOMBIE_BUDGETS);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('missing-lod');
    expect(report.errors.find((e) => e.code === 'missing-lod')?.subject).toBe('impostor');
  });

  it('rejects an over-budget triangle count', () => {
    const d = makeZombieContract();
    const overBudget = triangles(999_999);
    const broken: ZombieAssetContract = {
      ...d,
      lods: {
        levels: d.lods.levels.map((l) => (l.level === 'hero' ? { ...l, triangles: overBudget } : l)),
      },
      performance: {
        ...d.performance,
        trianglesByLod: { ...d.performance.trianglesByLod, hero: overBudget },
      },
    };
    const report = validateAsset(broken, DEFAULT_ZOMBIE_BUDGETS);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('triangle-budget-exceeded');
  });

  it('rejects a detachable region with no collision proxy (never a silent missing collider, V7)', () => {
    const d = makeZombieContract();
    const broken: ZombieAssetContract = {
      ...d,
      collision: {
        ...d.collision,
        anatomicalProxies: d.collision.anatomicalProxies.filter((p) => p.regionId !== 'arm_l'),
      },
    };
    const report = validateAsset(broken, DEFAULT_ZOMBIE_BUDGETS);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('missing-collision-proxy');
  });

  it('rejects an environment asset whose fracture family is not mapped to structural cells', () => {
    const d = makeEnvironmentContract();
    const broken = {
      ...d,
      fractureFamilies: d.fractureFamilies.map((f) => ({ ...f, structuralCellIds: ['nope'] })),
    };
    const report = validateAsset(broken, DEFAULT_ENVIRONMENT_BUDGETS);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('missing-fracture-mapping');
  });
});
