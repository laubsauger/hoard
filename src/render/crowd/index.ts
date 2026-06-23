// T9 — crowd barrel.

export {
  packCrowdInputs,
  variationSeed,
  variationScale,
  FLOATS_PER_POSE,
  FLOATS_PER_META,
  type PackOptions,
  type PackResult,
} from './packing';
export { Crowd, CrowdLimbs, resolveCrowdSettings, type CrowdSettings } from './crowd';
export { visionCullFade, type VisionCull } from './visionCull';
export {
  packLimbInputs,
  composeLimbMatrix,
  walkSwing,
  walkBob,
  FLOATS_PER_LIMB_POSE,
  FLOATS_PER_MAT4,
  type LimbPackOptions,
  type LimbPackResult,
  type LimbPartPlacement,
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
