// T28 — world render barrel (visibility / cutaway).

export {
  resolveVisibilitySettings,
  resolveSurfaceVisibility,
  exteriorWallOccludesPlayer,
  wallBetweenPlayerAndCamera,
  surfaceInXrayField,
  segmentIntersectsAabbXZ,
  clampConeRangeToWall,
  classifyThreat,
  threatMarkerStyle,
  type ExteriorWallCutawayInput,
  type PlayerCameraOcclusionInput,
  type XrayFieldInput,
  type SurfaceKind,
  type VisibilitySettings,
  type OcclusionContext,
  type SurfaceVisibility,
  type ThreatAwareness,
  type ThreatPerception,
  type ThreatMarkerStyle,
} from './visibility';
