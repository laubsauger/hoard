// T28 / V20 — visibility + cutaway logic. Hide/fade roofs + upper wall sections via room/portal/camera-
// occlusion logic; preserve enough wall BASE to read enclosure + breach state; interior darkness +
// line-of-sight are gameplay SYSTEMS, not post-fx. Critically: do NOT reveal all interiors just because
// the camera is above (V20). Also provides the visual-language data for known/visible/heard/remembered
// threats (color-INDEPENDENT per V29 — a style enum, not just a hue). Pure logic, no GPU.

import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import type { QualityTier } from '../../config/types';

/** Building surfaces the cutaway system reasons about. */
export type SurfaceKind = 'roof' | 'upperWall' | 'baseWall' | 'interior';

export interface VisibilitySettings {
  /** Wall height (m) from the floor always kept opaque to read enclosure + breach (V20). */
  readonly baseHeightMeters: number;
  /** Wall height (m) above which sections may fade when occluding the camera. */
  readonly upperFadeStartMeters: number;
}

export function resolveVisibilitySettings(tier: QualityTier): VisibilitySettings {
  return {
    baseHeightMeters: resolve(renderingConfig.wallBasePreservedHeightMeters, tier),
    upperFadeStartMeters: resolve(renderingConfig.upperWallFadeStartHeightMeters, tier),
  };
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
