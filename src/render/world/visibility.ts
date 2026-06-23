// T28 / V20 — visibility + cutaway logic. Hide/fade roofs + upper wall sections via room/portal/camera-
// occlusion logic; preserve enough wall BASE to read enclosure + breach state; interior darkness +
// line-of-sight are gameplay SYSTEMS, not post-fx. Critically: do NOT reveal all interiors just because
// the camera is above (V20). Also provides the visual-language data for known/visible/heard/remembered
// threats (color-INDEPENDENT per V29 — a style enum, not just a hue). Pure logic, no GPU.

import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import { postFXConfig } from '../../config/domains/postFX';
import type { QualityTier } from '../../config/types';

/** Building surfaces the cutaway system reasons about. */
export type SurfaceKind = 'roof' | 'upperWall' | 'baseWall' | 'interior';

export interface VisibilitySettings {
  /** Wall height (m) from the floor always kept opaque to read enclosure + breach (V20). */
  readonly baseHeightMeters: number;
  /** Wall height (m) above which sections may fade when occluding the camera. */
  readonly upperFadeStartMeters: number;
  /**
   * DIRECTIONAL cutaway threshold (V58): cosine above which an upper wall's outward normal is considered
   * "turned toward the camera" (i.e. between camera + player → occluding). See `wallFacesCamera`.
   */
  readonly cameraFacingDotThreshold: number;
  /**
   * OUTSIDE-WALL cutaway band (V62): how close the player must stand to an EXTERIOR wall (on its outward side)
   * for that wall to fade when it lies between the camera and the player. See `exteriorWallOccludesPlayer`.
   */
  readonly exteriorCutawayAdjacencyMeters: number;
}

export function resolveVisibilitySettings(tier: QualityTier): VisibilitySettings {
  return {
    baseHeightMeters: resolve(renderingConfig.wallBasePreservedHeightMeters, tier),
    upperFadeStartMeters: resolve(renderingConfig.upperWallFadeStartHeightMeters, tier),
    cameraFacingDotThreshold: resolve(renderingConfig.cutawayCameraFacingDotThreshold, tier),
    exteriorCutawayAdjacencyMeters: resolve(renderingConfig.exteriorCutawayAdjacencyMeters, tier),
  };
}

/** A horizontal (XZ-plane) direction/normal. */
export interface VecXZ {
  readonly x: number;
  readonly z: number;
}

export interface WallFacingInput {
  /** The wall's outward-facing horizontal normal (points from the enclosed space toward open space). */
  readonly outwardNormal: VecXZ;
  /** Unit horizontal vector pointing from the player/room toward the camera (cameraPos − playerPos, XZ). */
  readonly towardCamera: VecXZ;
  /** Cosine threshold above which the wall counts as camera-facing (occluding the camera→player view). */
  readonly facingDotThreshold: number;
}

/**
 * DIRECTIONAL cutaway decision (T82 / V58): a wall occludes the camera→player view ONLY when its outward
 * face turns toward the camera — i.e. it sits between the camera and the player. We test the normalized
 * horizontal dot of the wall's outward normal with the toward-camera direction: > threshold ⇒ camera-facing
 * (the near/occluding wall → fade); the FAR walls (normal pointing away, dot ≤ threshold) stay opaque so the
 * room still reads as enclosed. This is what makes the cutaway directional instead of a roofless open box.
 * Pure, GPU-free. Defensive-normalizes both vectors; a degenerate (zero-length) input never occludes.
 */
export function wallFacesCamera(input: WallFacingInput): boolean {
  const n = input.outwardNormal;
  const c = input.towardCamera;
  const nl = Math.hypot(n.x, n.z);
  const cl = Math.hypot(c.x, c.z);
  if (nl === 0 || cl === 0) return false;
  const dot = (n.x * c.x + n.z * c.z) / (nl * cl);
  return dot > input.facingDotThreshold;
}

export interface ExteriorWallCutawayInput {
  /** The wall's outward-facing horizontal normal (points from the enclosed building toward open space). */
  readonly outwardNormal: VecXZ;
  /** A point ON the wall's plane (its world-XZ centre is fine — the wall shell is thin). */
  readonly wallCenter: VecXZ;
  /** Player world-XZ. */
  readonly player: VecXZ;
  /** Camera world-XZ. */
  readonly camera: VecXZ;
  /** Max distance (m) the player may stand OUTSIDE the wall (along its outward normal) and still trigger. */
  readonly adjacencyMeters: number;
}

/**
 * OUTSIDE-WALL cutaway decision (V62): fade an EXTERIOR wall when the player is standing just OUTSIDE it and the
 * wall plane lies BETWEEN the camera and the player — so an exterior wall never hides the player from an orbiting
 * camera that has swung around behind it. We project both the player and the camera onto the wall's outward
 * normal (signed distance from the wall plane): the player must be on the OUTWARD side within the adjacency band
 * (0 ≤ playerSide ≤ adjacency), and the camera must be on the INWARD (building) side (cameraSide < 0) — i.e. the
 * plane separates them. Purely a VIEW aid: this never touches the structural/nav grid, so crowd reveal + LOS are
 * unaffected (V63). Pure + GPU-free; a degenerate (zero-length) normal never occludes.
 */
export function exteriorWallOccludesPlayer(input: ExteriorWallCutawayInput): boolean {
  const n = input.outwardNormal;
  const nl = Math.hypot(n.x, n.z);
  if (nl === 0) return false;
  const nx = n.x / nl;
  const nz = n.z / nl;
  const playerSide = (input.player.x - input.wallCenter.x) * nx + (input.player.z - input.wallCenter.z) * nz;
  const cameraSide = (input.camera.x - input.wallCenter.x) * nx + (input.camera.z - input.wallCenter.z) * nz;
  if (playerSide < 0 || playerSide > input.adjacencyMeters) return false; // player not just-outside this wall
  return cameraSide < 0; // wall plane sits between the (inward) camera and the (outward) player
}

export interface OcclusionContext {
  /** Is the player currently inside this room/module? */
  readonly playerInside: boolean;
  /** Does this surface sit between the camera and the space the player is occupying/looking into? */
  readonly occludesPlayerView: boolean;
  /** Is the room enclosed (has a roof / full walls) vs open-air? */
  readonly roomEnclosed: boolean;
  /**
   * Is there an open portal (door/window/breach) or established line-of-sight from the camera into the
   * interior? This — NOT mere camera height — is what may reveal an interior (V20).
   */
  readonly portalOrLosToCamera: boolean;
  /** For wall surfaces: the section's height above the floor (m). */
  readonly surfaceHeightMeters: number;
}

export interface SurfaceVisibility {
  /** Whether the surface renders at all this frame. */
  readonly visible: boolean;
  /** Target opacity 0..1 (drives the timed roofFade). 1 = fully opaque. */
  readonly targetOpacity: number;
  /** Human-/debug-readable reason for the decision. */
  readonly reason: string;
}

/**
 * Decide a surface's visibility. Rules (V20):
 *  - baseWall: ALWAYS opaque — needed to read enclosure + breach state.
 *  - roof / upperWall: fade out ONLY when enclosed AND they occlude the player's view; otherwise opaque.
 *  - interior: hidden UNLESS the player is inside OR a portal/LOS reveals it. Camera-above never reveals.
 */
export function resolveSurfaceVisibility(
  surface: SurfaceKind,
  ctx: OcclusionContext,
  settings: VisibilitySettings,
): SurfaceVisibility {
  switch (surface) {
    case 'baseWall':
      return { visible: true, targetOpacity: 1, reason: 'base preserved to read enclosure + breach (V20)' };

    case 'roof': {
      if (ctx.roomEnclosed && ctx.occludesPlayerView) {
        return { visible: false, targetOpacity: 0, reason: 'roof occludes player view of enclosed room — faded (V20)' };
      }
      return { visible: true, targetOpacity: 1, reason: 'roof not occluding player view — kept' };
    }

    case 'upperWall': {
      // Anything within the preserved base band stays opaque even if tagged "upper".
      if (ctx.surfaceHeightMeters <= settings.baseHeightMeters) {
        return { visible: true, targetOpacity: 1, reason: 'within preserved base height — kept (V20)' };
      }
      if (ctx.surfaceHeightMeters >= settings.upperFadeStartMeters && ctx.roomEnclosed && ctx.occludesPlayerView) {
        return { visible: false, targetOpacity: 0, reason: 'upper wall occludes player view — faded (V20)' };
      }
      return { visible: true, targetOpacity: 1, reason: 'upper wall not occluding — kept' };
    }

    case 'interior': {
      // V20: NEVER reveal interiors merely because the camera is above. Requires player inside or LOS.
      if (ctx.playerInside || ctx.portalOrLosToCamera) {
        return { visible: true, targetOpacity: 1, reason: 'interior revealed by presence or portal/LOS (V20)' };
      }
      return { visible: false, targetOpacity: 0, reason: 'interior hidden — camera height alone does not reveal (V20)' };
    }
  }
}

// ---- Cutaway depth bias (B3 — reveal faces must not z-fight retained base/ground/roof) ----

export interface CutawayDepthSettings {
  readonly polygonOffsetFactor: number;
  readonly polygonOffsetUnits: number;
  readonly insetMeters: number;
}

export function resolveCutawayDepthSettings(tier: QualityTier): CutawayDepthSettings {
  return {
    polygonOffsetFactor: resolve(postFXConfig.cutawayPolygonOffsetFactor, tier),
    polygonOffsetUnits: resolve(postFXConfig.cutawayPolygonOffsetUnits, tier),
    insetMeters: resolve(postFXConfig.cutawayInsetMeters, tier),
  };
}

export interface CutawayDepthOffset {
  /** Enable material polygonOffset (push fragments back in depth). */
  readonly polygonOffset: boolean;
  readonly polygonOffsetFactor: number;
  readonly polygonOffsetUnits: number;
  /** Draw fading sections AFTER opaque base/ground so the transparent reveal composites cleanly. */
  readonly renderOrder: number;
  /** Vertical gap (m) to lift a fading upper section off the retained base so faces aren't coplanar. */
  readonly verticalInsetMeters: number;
}

/**
 * Decide the depth bias for a fading cutaway surface (B3). The cutaway fades roof + upper walls whose
 * faces sit coplanar with the retained wall base (upper bottom == base top) and the ground/roof line —
 * coplanar faces z-fight on reveal. We push fading faces back with polygonOffset, draw them after the
 * opaque base (renderOrder > 0), and lift upper walls by a small vertical inset so the shared seam is gone.
 * Base/interior surfaces never bias (they own the depth buffer). Pure logic.
 */
export function resolveCutawayDepthOffset(kind: SurfaceKind, settings: CutawayDepthSettings): CutawayDepthOffset {
  const fades = kind === 'roof' || kind === 'upperWall';
  return {
    polygonOffset: fades,
    polygonOffsetFactor: fades ? settings.polygonOffsetFactor : 0,
    polygonOffsetUnits: fades ? settings.polygonOffsetUnits : 0,
    renderOrder: fades ? 1 : 0,
    // Only the upper wall shares a horizontal seam with the base; the roof sits at the wall top already.
    verticalInsetMeters: kind === 'upperWall' ? settings.insetMeters : 0,
  };
}

// ---- Threat visual language (V20 / V29) ----

/** How much the renderer knows about a threat right now. */
export type ThreatAwareness = 'visible' | 'heard' | 'remembered' | 'known' | 'unknown';

export interface ThreatPerception {
  /** Currently within the player's line of sight. */
  readonly inLineOfSight: boolean;
  /** Produced an audible stimulus recently (heard but not seen). */
  readonly recentlyHeard: boolean;
  /** Was seen before but is now occluded (last-known position). */
  readonly lastKnownStale: boolean;
  /** Flagged by another system (alarm/companion/objective) without direct perception. */
  readonly flaggedKnown: boolean;
}

/** Resolve the strongest applicable awareness, most-certain first (visible > heard > remembered > known). */
export function classifyThreat(p: ThreatPerception): ThreatAwareness {
  if (p.inLineOfSight) return 'visible';
  if (p.recentlyHeard) return 'heard';
  if (p.lastKnownStale) return 'remembered';
  if (p.flaggedKnown) return 'known';
  return 'unknown';
}

/** Color-INDEPENDENT marker style (V29): shape + fill carry meaning, not hue alone. */
export interface ThreatMarkerStyle {
  readonly awareness: ThreatAwareness;
  /** Marker glyph shape. */
  readonly shape: 'solid' | 'ring' | 'ping' | 'ghost' | 'none';
  /** Whether the marker is shown at the entity (true) or at a last-known location (false). */
  readonly atEntity: boolean;
  /** Whether it pulses (draws attention) — used sparingly. */
  readonly pulse: boolean;
}

export function threatMarkerStyle(awareness: ThreatAwareness): ThreatMarkerStyle {
  switch (awareness) {
    case 'visible': return { awareness, shape: 'solid', atEntity: true, pulse: false };
    case 'heard': return { awareness, shape: 'ping', atEntity: false, pulse: true };
    case 'remembered': return { awareness, shape: 'ghost', atEntity: false, pulse: false };
    case 'known': return { awareness, shape: 'ring', atEntity: false, pulse: false };
    case 'unknown': return { awareness, shape: 'none', atEntity: false, pulse: false };
  }
}
