// T9 — crowd barrel.

export {
  packCrowdInputs,
  variationSeed,
  variationScale,
  variationHash01,
  variationTint,
  FLOATS_PER_POSE,
  FLOATS_PER_META,
  type PackOptions,
  type PackResult,
} from './packing';
export { Crowd, CrowdLimbs, resolveCrowdSettings, type CrowdSettings } from './crowd';
export { RiggedCrowd, type TrackFn } from './rigged';
export {
  ARCHETYPE_KEYS,
  CLIP_MAPS,
  archetypeKeyForIndex,
  bakeClipNames,
  clipForState,
  buildClipTable,
  phaseToFrameRow,
  clipPhaseRateHz,
  advancePhase,
  type ArchetypeKey,
  type ClipStateMap,
  type ClipTable,
  type ClipTableEntry,
  type ClipFrameSpec,
} from './riggedAnim';
export { visionCullFade, type VisionCull } from './visionCull';
export { instantaneousReveal, PerceptionMemory, type RevealParams } from './perceptionMemory';
export {
  packLimbInputs,
  composeLimbMatrix,
  walkSwing,
  walkBob,
  limbGait,
  gaitPhaseRateHz,
  stateReachTarget,
  FLOATS_PER_LIMB_POSE,
  FLOATS_PER_MAT4,
  type LimbPackOptions,
  type LimbPackResult,
  type LimbPartPlacement,
  type LimbGait,
  type LimbGaitConfig,
} from './limbs';
export {
  RENDER_PATHS,
  MATERIAL_FAMILIES,
  selectRenderPath,
  composeVariation,
  resolveCrowdPathSettings,
  CrowdMaterialLibrary,
  type RenderPath,
  type MaterialFamily,
  type CrowdPathSettings,
  type PathSelectionInput,
  type VariationModules,
} from './paths';
