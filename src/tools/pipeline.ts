// T34 / V7 — pipeline orchestration.
// The asset pipeline is an ordered list of typed transforms over a build state. Each stage declares
// the prior stages it requires, runs, and either succeeds (carrying provenance forward) or fails with
// structured errors that halt the pipeline. This scaffold orchestrates the flow; real mesh processing
// is left behind the stage `run` boundary (default impls record provenance, see stages.ts).

import type { AssetContract } from '@/assets';
import type { ValidationError, ValidationReport } from './validation';

/** The 10 pipeline stages, in execution order (V7 normalization → validation → optimization → style). */
export type PipelineStageId =
  | 'import-provenance'
  | 'clean-topology'
  | 'retopo-decimate'
  | 'skeleton-assign'
  | 'region-split'
  | 'uv-bake'
  | 'art-direction'
  | 'lod-shadow-collision-impostor'
  | 'compress-metadata'
  | 'validate-at-distance';

export const PIPELINE_STAGE_ORDER: readonly PipelineStageId[] = [
  'import-provenance',
  'clean-topology',
  'retopo-decimate',
  'skeleton-assign',
  'region-split',
  'uv-bake',
  'art-direction',
  'lod-shadow-collision-impostor',
  'compress-metadata',
  'validate-at-distance',
];

/** Provenance entry appended once per completed stage. Carried forward through the whole pipeline. */
export interface ProvenanceRecord {
  readonly stage: PipelineStageId;
  readonly title: string;
  readonly atIso: string;
  readonly summary: string;
}

/** Small typed artifact a stage records about what it did. */
export type StageArtifact = Readonly<Record<string, string | number | boolean>>;

export interface BuildState {
  readonly descriptor: AssetContract;
  readonly trail: readonly ProvenanceRecord[];
  readonly completed: readonly PipelineStageId[];
  readonly artifacts: Readonly<Record<PipelineStageId, StageArtifact>>;
}

export interface StageError {
  readonly stage: PipelineStageId;
  readonly message: string;
}

/** Result a stage returns. On success the (possibly enriched) descriptor + an artifact + a summary. */
export type StageRun =
  | {
      readonly ok: true;
      readonly descriptor: AssetContract;
      readonly summary: string;
      readonly artifact: StageArtifact;
      /** Validation report when the stage produced one (the validate stage), else null. */
      readonly report: ValidationReport | null;
    }
  | {
      readonly ok: false;
      readonly errors: readonly StageError[];
      /** The validation report when the failure came from the validate stage (V7), else null. */
      readonly report: ValidationReport | null;
    };

export interface PipelineStage {
  readonly id: PipelineStageId;
  readonly title: string;
  /** Stage ids that must already be completed before this one runs. */
  readonly requires: readonly PipelineStageId[];
  run(state: BuildState): StageRun;
}

export interface PipelineRunResult {
  readonly ok: boolean;
  readonly assetId: string;
  readonly executed: readonly PipelineStageId[];
  readonly trail: readonly ProvenanceRecord[];
  readonly finalState: BuildState;
  readonly failedStage: PipelineStageId | null;
  readonly errors: readonly StageError[];
  /** Validation report from the validate-at-distance stage (V7), when it ran. */
  readonly report: ValidationReport | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyState(descriptor: AssetContract): BuildState {
  return {
    descriptor,
    trail: [],
    completed: [],
    artifacts: {} as Record<PipelineStageId, StageArtifact>,
  };
}

function missingRequirements(stage: PipelineStage, completed: readonly PipelineStageId[]): PipelineStageId[] {
  const done = new Set(completed);
  return stage.requires.filter((req) => !done.has(req));
}

/** Run an ordered pipeline over a descriptor. Stops at the first failing stage. */
export function runPipeline(descriptor: AssetContract, stages: readonly PipelineStage[]): PipelineRunResult {
  let state = emptyState(descriptor);
  const executed: PipelineStageId[] = [];
  let report: ValidationReport | null = null;

  for (const stage of stages) {
    const missing = missingRequirements(stage, state.completed);
    if (missing.length > 0) {
      const errors: StageError[] = [
        {
          stage: stage.id,
          message: `stage '${stage.id}' missing prerequisites: ${missing.join(', ')}`,
        },
      ];
      return {
        ok: false,
        assetId: descriptor.id,
        executed,
        trail: state.trail,
        finalState: state,
        failedStage: stage.id,
        errors,
        report: null,
      };
    }

    const run = stage.run(state);
    if (!run.ok) {
      const validationErrors: StageError[] =
        run.report?.errors.map((e: ValidationError) => ({ stage: stage.id, message: `${e.code}: ${e.message}` })) ??
        [];
      return {
        ok: false,
        assetId: descriptor.id,
        executed,
        trail: state.trail,
        finalState: state,
        failedStage: stage.id,
        errors: [...run.errors, ...validationErrors],
        report: run.report,
      };
    }

    if (run.report) {
      report = run.report;
    }
    const record: ProvenanceRecord = {
      stage: stage.id,
      title: stage.title,
      atIso: nowIso(),
      summary: run.summary,
    };
    state = {
      descriptor: run.descriptor,
      trail: [...state.trail, record],
      completed: [...state.completed, stage.id],
      artifacts: { ...state.artifacts, [stage.id]: run.artifact },
    };
    executed.push(stage.id);
  }

  return {
    ok: true,
    assetId: descriptor.id,
    executed,
    trail: state.trail,
    finalState: state,
    failedStage: null,
    errors: [],
    report,
  };
}
