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
export { Crowd, resolveCrowdSettings, type CrowdSettings } from './crowd';
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
