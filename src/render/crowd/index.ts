// T9 / T140 — crowd barrel.

export {
  computeDistanceBand,
  variationSeed,
  variationScale,
  variationHash01,
  variationTint,
  BAND_RIGGED,
  BAND_IMPOSTOR,
} from './packing';
export { Crowd, resolveCrowdSettings, type CrowdSettings } from './crowd';
export { RiggedCrowd, RIGGED_HEIGHT_METERS, resolveRagdollConfig, type TrackFn } from './rigged';
export { CrowdImpostors, bakeImpostorAtlas, nearestImpostorTile, type ImpostorAtlas, type BakeImpostorOptions } from './impostor';
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
