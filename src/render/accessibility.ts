// T40 / V29 — accessibility -> render parameter bridge. Maps the user's persisted accessibility settings
// (lane U store) onto the typed parameters the render lane already accepts: the gore-intensity multiplier
// (gore.ts), the camera-shake / flash / motion feedback (postfx.ts damageFeedback), and the selective-
// outline strength (outlines.ts). This is the single seam where accessibility flows END-TO-END into the
// renderer — the render systems stay pure and just consume injected values (no store import in the engine).
// Pure logic, no GPU.

import type { AccessibilityFeedback } from './effects/postfx';
import type { OutlineSettings } from './materials/outlines';

/** The accessibility fields the renderer cares about. A plain shape so the engine never imports the store. */
export interface RenderAccessibilityInput {
  readonly goreIntensity: number; // 0..1
  readonly outlineStrength: number; // 0..1
  readonly targetHighlightStrength: number; // 0..1
  readonly cameraShakeScale: number; // 0..1
  readonly reduceFlashes: boolean;
  readonly motionReduction: boolean;
}

export interface RenderAccessibility {
  /** Fed to GoreSystem.ingest (0 fully suppresses gore — V29). */
  readonly goreIntensity: number;
  /** Multiplier applied to selective-outline widths (0 = no per-body outlines — V29). */
  readonly outlineStrength: number;
  /** Highlight strength for the actively targeted threat (0 = no highlight). */
  readonly targetHighlightStrength: number;
  /** Fed to postfx.damageFeedback (shake / flash / motion — V29). */
  readonly feedback: AccessibilityFeedback;
}

function clamp01(v: number, name: string): number {
  if (!Number.isFinite(v)) throw new Error(`${name} must be finite, got ${v}`);
  return Math.min(1, Math.max(0, v));
}

/** Resolve the user's accessibility settings into the render lane's injected parameters (V29). */
export function resolveRenderAccessibility(input: RenderAccessibilityInput): RenderAccessibility {
  return {
    goreIntensity: clamp01(input.goreIntensity, 'goreIntensity'),
    outlineStrength: clamp01(input.outlineStrength, 'outlineStrength'),
    targetHighlightStrength: clamp01(input.targetHighlightStrength, 'targetHighlightStrength'),
    feedback: {
      shakeScale: clamp01(input.cameraShakeScale, 'cameraShakeScale'),
      reduceFlashes: input.reduceFlashes,
      reduceMotion: input.motionReduction,
    },
  };
}

/**
 * Scale the selective-outline widths by the accessibility outline-strength multiplier (V29). At strength 0
 * every per-body outline width collapses to 0 (the dark-mass-only reading); at 1 the hierarchy is intact.
 * The readability thresholds + distances are preserved (they govern WHICH things get an outline, not how
 * strong it is). Returns a NEW settings object — the source is never mutated.
 */
export function scaleOutlineSettings(settings: OutlineSettings, strength: number): OutlineSettings {
  const s = clamp01(strength, 'outline strength');
  return {
    ...settings,
    playerWidthPx: settings.playerWidthPx * s,
    threatWidthPx: settings.threatWidthPx * s,
    architectureWidthPx: settings.architectureWidthPx * s,
    clutterWidthPx: settings.clutterWidthPx * s,
    rimStrength: settings.rimStrength * s,
  };
}
