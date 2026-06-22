// T19 / T31 — effects barrel (gore + post-processing).

export {
  GoreSystem,
  GoreRenderer,
  resolveGoreSettings,
  type GoreKind,
  type GoreParticle,
  type GoreSettings,
} from './gore';
export {
  SCALING_STAGES,
  INITIAL_SCALING_STATE,
  isScalingLever,
  planScaling,
  resolveDynamicResolutionSettings,
  selectGradingProfile,
  resolveBloomSettings,
  damageFeedback,
  type ScalingStage,
  type ScalingState,
  type ScalingDecision,
  type DynamicResolutionSettings,
  type GradingSelector,
  type BloomSettings,
  type DamageFeedback,
  type AccessibilityFeedback,
} from './postfx';
