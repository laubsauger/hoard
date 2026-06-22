import { describe, expect, it } from 'vitest';
import { runPipeline, PIPELINE_STAGE_ORDER } from './pipeline';
import { defaultPipelineFor } from './stages';
import { makeZombieContract, makeEnvironmentContract } from './fixtures';

describe('asset pipeline orchestration (T34)', () => {
  it('runs all 10 stages in order, carrying provenance forward', () => {
    const descriptor = makeZombieContract();
    const result = runPipeline(descriptor, defaultPipelineFor(descriptor));

    expect(result.ok).toBe(true);
    expect(result.executed).toEqual(PIPELINE_STAGE_ORDER);
    // One provenance record per stage, in order.
    expect(result.trail).toHaveLength(PIPELINE_STAGE_ORDER.length);
    expect(result.trail.map((r) => r.stage)).toEqual(PIPELINE_STAGE_ORDER);
    // Every stage recorded a summary + artifact.
    expect(result.trail.every((r) => r.summary.length > 0)).toBe(true);
    expect(Object.keys(result.finalState.artifacts)).toHaveLength(PIPELINE_STAGE_ORDER.length);
    // The import stage carried license provenance forward.
    expect(result.finalState.artifacts['import-provenance']?.['license']).toBe('studio-internal-1.0');
    // Final stage produced an accepting validation report.
    expect(result.report?.ok).toBe(true);
  });

  it('runs the environment pipeline end-to-end', () => {
    const descriptor = makeEnvironmentContract();
    const result = runPipeline(descriptor, defaultPipelineFor(descriptor));

    expect(result.ok).toBe(true);
    expect(result.executed).toEqual(PIPELINE_STAGE_ORDER);
    expect(result.report?.ok).toBe(true);
  });

  it('halts at the validate stage and surfaces a report + placeholder when content is invalid', () => {
    const descriptor = makeZombieContract();
    // Drop a required bone — validation must reject.
    const broken = {
      ...descriptor,
      skeleton: { ...descriptor.skeleton, bones: descriptor.skeleton.bones.filter((b) => b !== 'head') },
    };
    const result = runPipeline(broken, defaultPipelineFor(broken));

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe('validate-at-distance');
    // The 9 record stages ran; only the validate stage failed.
    expect(result.executed).toHaveLength(9);
    expect(result.report?.ok).toBe(false);
    expect(result.report?.placeholder?.isPlaceholder).toBe(true);
    expect(result.errors.some((e) => e.message.includes('missing-skeleton-bone'))).toBe(true);
  });

  it('fails fast when a stage prerequisite is not met', () => {
    const descriptor = makeZombieContract();
    const full = defaultPipelineFor(descriptor);
    // Run the chain without the first stage so 'clean-topology' is missing its prerequisite.
    const result = runPipeline(descriptor, full.slice(1));

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe('clean-topology');
    expect(result.errors[0]?.message).toContain('missing prerequisites');
  });
});
