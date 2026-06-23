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
  CombatFeedbackSystem,
  CombatFeedbackView,
  resolveCombatFeedbackSettings,
  type CombatFeedbackSettings,
  type IngestContext,
} from './combatFeedback';
export {
  BloodSim,
  BloodView,
  resolveBloodSettings,
  goreColor,
  type BloodSettings,
  type BloodIngestContext,
  type GoreType,
  type SurfaceHit,
  type SurfaceProjector,
} from './bloodView';
export { RaycastSurfaceProjector } from './surfaceProjector';
export {
  GibSim,
  GibView,
  resolveGibSettings,
  type GibSettings,
  type GibIngestContext,
} from './gibView';
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
