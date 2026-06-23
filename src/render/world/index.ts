// T28 — world render barrel (visibility / cutaway).

export {
  resolveVisibilitySettings,
  resolveSurfaceVisibility,
  exteriorWallOccludesPlayer,
  wallBetweenPlayerAndCamera,
  clampConeRangeToWall,
  classifyThreat,
  threatMarkerStyle,
  type ExteriorWallCutawayInput,
  type PlayerCameraOcclusionInput,
  type SurfaceKind,
  type VisibilitySettings,
  type OcclusionContext,
  type SurfaceVisibility,
  type ThreatAwareness,
  type ThreatPerception,
  type ThreatMarkerStyle,
} from './visibility';
