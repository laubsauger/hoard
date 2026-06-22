// T9 — crowd barrel.

export {
  packInstances,
  variationSeed,
  FLOATS_PER_MATRIX,
  FLOATS_PER_VARIATION,
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
