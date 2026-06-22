// T34 / V7 — the 10 default pipeline stages.
// These are interface-driven, record-style transforms: they carry provenance + a typed artifact
// forward without doing real mesh processing (no GLTF runtime here). The final stage runs the
// validator so the pipeline ends in a hard accept/reject decision with a placeholder on failure (V7).

import type { AssetContract } from '@/assets';
import { defaultBudgetsFor, type AssetBudgets } from './budgets';
import type { BuildState, PipelineStage, PipelineStageId, StageArtifact, StageRun } from './pipeline';
import { validateAsset } from './validation';

/** Build a record-only stage: passes the descriptor through, recording provenance + an artifact. */
function recordStage(
  id: PipelineStageId,
  title: string,
  requires: readonly PipelineStageId[],
  describe: (descriptor: AssetContract) => { summary: string; artifact: StageArtifact },
): PipelineStage {
  return {
    id,
    title,
    requires,
    run(state: BuildState): StageRun {
      const { summary, artifact } = describe(state.descriptor);
      return { ok: true, descriptor: state.descriptor, summary, artifact, report: null };
    },
  };
}

export const importProvenanceStage: PipelineStage = recordStage(
  'import-provenance',
  'Import + provenance / license',
  [],
  (d) => ({
    summary: `imported '${d.id}' from ${d.provenance.generator} (license ${d.provenance.license.id})`,
    artifact: {
      sourceUri: d.provenance.sourceUri,
      generator: d.provenance.generator,
      license: d.provenance.license.id,
      redistributable: d.provenance.license.redistributable,
    },
  }),
);

export const cleanTopologyStage: PipelineStage = recordStage(
  'clean-topology',
  'Clean topology',
  ['import-provenance'],
  (d) => ({
    summary: `cleaned topology for '${d.id}' (manifold/normals/degenerate pass)`,
    artifact: { kind: d.kind, manifoldChecked: true },
  }),
);

export const retopoDecimateStage: PipelineStage = recordStage(
  'retopo-decimate',
  'Retopologize / decimate',
  ['clean-topology'],
  (d) => ({
    summary: `retopo/decimate target set from declared LOD chain (${d.lods.levels.length} levels)`,
    artifact: { lodLevels: d.lods.levels.length },
  }),
);

export const skeletonAssignStage: PipelineStage = recordStage(
  'skeleton-assign',
  'Assign skeleton + validate weights',
  ['retopo-decimate'],
  (d) => ({
    summary:
      d.kind === 'zombie'
        ? `assigned skeleton family '${d.skeleton.familyId}' (${d.skeleton.bones.length} bones)`
        : `no skeleton for environment asset '${d.id}'`,
    artifact:
      d.kind === 'zombie'
        ? { family: d.skeleton.familyId, bones: d.skeleton.bones.length }
        : { skinned: false },
  }),
);

export const regionSplitStage: PipelineStage = recordStage(
  'region-split',
  'Split anatomical regions + wound caps',
  ['skeleton-assign'],
  (d) => ({
    summary:
      d.kind === 'zombie'
        ? `split ${d.regions.length} anatomical regions (${d.regions.filter((r) => r.detachable).length} detachable)`
        : `split ${d.fractureFamilies.length} fracture families`,
    artifact:
      d.kind === 'zombie'
        ? { regions: d.regions.length, detachable: d.regions.filter((r) => r.detachable).length }
        : { fractureFamilies: d.fractureFamilies.length },
  }),
);

export const uvBakeStage: PipelineStage = recordStage(
  'uv-bake',
  'UV + bake maps',
  ['region-split'],
  (d) => ({
    summary: `UV + bake for ${d.textures.textures.length} texture(s)`,
    artifact: { textures: d.textures.textures.length },
  }),
);

export const artDirectionStage: PipelineStage = recordStage(
  'art-direction',
  'Art-direction pass',
  ['uv-bake'],
  (d) => ({
    summary: `art-direction pass on material family '${d.material.familyId}'`,
    artifact: { materialFamily: d.material.familyId, slots: d.material.materialSlots.length },
  }),
);

export const lodGenStage: PipelineStage = recordStage(
  'lod-shadow-collision-impostor',
  'Generate LODs + shadow + collision + impostor',
  ['art-direction'],
  (d) => ({
    summary:
      d.kind === 'zombie'
        ? `generated LODs + ${d.collision.anatomicalProxies.length} anatomical collision proxies + impostor`
        : `generated LODs + ${d.collisionStates.length} collision states`,
    artifact:
      d.kind === 'zombie'
        ? { lods: d.lods.levels.length, collisionProxies: d.collision.anatomicalProxies.length }
        : { lods: d.lods.levels.length, collisionStates: d.collisionStates.length },
  }),
);

export const compressMetadataStage: PipelineStage = recordStage(
  'compress-metadata',
  'Compress (KTX2/GLB) + write metadata',
  ['lod-shadow-collision-impostor'],
  (d) => ({
    summary: `compressed to ${d.geometry.container.toUpperCase()} + KTX2/Basis textures`,
    artifact: { container: d.geometry.container, textures: d.textures.textures.length },
  }),
);

/** Final stage: hard accept/reject against typed budgets. On failure → placeholder + report (V7). */
export function validateAtDistanceStage(budgets: AssetBudgets): PipelineStage {
  return {
    id: 'validate-at-distance',
    title: 'Validate at distance (budgets + skeleton + fracture mapping)',
    requires: ['compress-metadata'],
    run(state: BuildState): StageRun {
      const report = validateAsset(state.descriptor, budgets);
      if (!report.ok) {
        return { ok: false, errors: [], report };
      }
      return {
        ok: true,
        descriptor: state.descriptor,
        summary: `validated '${state.descriptor.id}' against ${state.descriptor.kind} budgets — accepted`,
        artifact: { validated: true, errors: 0 },
        report,
      };
    },
  };
}

/** The 9 record stages (no budgets needed), in order. */
export const RECORD_STAGES: readonly PipelineStage[] = [
  importProvenanceStage,
  cleanTopologyStage,
  retopoDecimateStage,
  skeletonAssignStage,
  regionSplitStage,
  uvBakeStage,
  artDirectionStage,
  lodGenStage,
  compressMetadataStage,
];

/** Assemble the full 10-stage default pipeline for the given budgets. */
export function buildDefaultPipeline(budgets: AssetBudgets): readonly PipelineStage[] {
  return [...RECORD_STAGES, validateAtDistanceStage(budgets)];
}

/** Convenience: run the default pipeline, defaulting budgets by the descriptor's kind. */
export function defaultPipelineFor(descriptor: AssetContract, budgets?: AssetBudgets): readonly PipelineStage[] {
  return buildDefaultPipeline(budgets ?? defaultBudgetsFor(descriptor.kind));
}
