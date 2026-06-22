// T32 / V20 / V29 — outline hierarchy + small-character readability.
// Player = strongest screen-space silhouette (+ subtle rim). Nearby threats = medium outlines with
// head/limb separation + wound state. Distant horde = few/no per-body outlines (dark mass) with a few
// selectively highlighted members. Architecture edges restrained (doors/windows/stairs/breach). Clutter
// minimal. Readability is evaluated at the expected gameplay PIXEL HEIGHT: below a threshold, per-body
// outlines are dropped and the member joins the dark mass. Pure logic, no GPU.

import { resolve } from '../../config/spec';
import { materialsConfig } from '../../config/domains/materials';
import type { QualityTier } from '../../config/types';

/** Outline treatments, strongest -> weakest. `darkMass` and `none` carry no per-body outline. */
export const OUTLINE_TIERS = [
  'playerStrong',
  'threatMedium',
  'architecture',
  'clutterMinimal',
  'darkMass',
  'none',
] as const;
export type OutlineTier = (typeof OUTLINE_TIERS)[number];

/** What kind of thing is being outlined. */
export type OutlineSubject = 'player' | 'threat' | 'architecture' | 'clutter';

export interface OutlineSettings {
  readonly playerWidthPx: number;
  readonly threatWidthPx: number;
  readonly architectureWidthPx: number;
  readonly clutterWidthPx: number;
  readonly rimStrength: number;
  readonly minReadablePixelHeight: number;
  readonly threatMaxDistanceMeters: number;
  readonly darkMassHighlightFraction: number;
}

export function resolveOutlineSettings(tier: QualityTier): OutlineSettings {
  return {
    playerWidthPx: resolve(materialsConfig.outlineWidthPlayerPx, tier),
    threatWidthPx: resolve(materialsConfig.outlineWidthThreatPx, tier),
    architectureWidthPx: resolve(materialsConfig.outlineWidthArchitecturePx, tier),
    clutterWidthPx: resolve(materialsConfig.outlineWidthClutterPx, tier),
    rimStrength: resolve(materialsConfig.playerRimStrength, tier),
    minReadablePixelHeight: resolve(materialsConfig.minReadablePixelHeight, tier),
    threatMaxDistanceMeters: resolve(materialsConfig.threatOutlineMaxDistanceMeters, tier),
    darkMassHighlightFraction: resolve(materialsConfig.darkMassHighlightFraction, tier),
  };
}

export interface OutlineInput {
  readonly subject: OutlineSubject;
  readonly distanceMeters: number;
  /** Gameplay threat 0..1 (raises priority for keeping an individual outline). */
  readonly threat: number;
  /** Expected on-screen character height in pixels at the current zoom. */
  readonly pixelHeight: number;
  /**
   * For a horde member: whether this specific member is one of the selectively highlighted few
   * (computed from darkMassHighlightFraction). Selected members keep a thin outline as a focal point.
   */
  readonly selectedHighlight?: boolean;
}

/**
 * Assign an outline tier (V20/T32):
 *  - player: always playerStrong (strongest silhouette).
 *  - architecture/clutter: their restrained tiers, independent of distance/threat.
 *  - threat: threatMedium while near AND readable; beyond the threat distance OR below the readable
 *    pixel height it becomes dark mass (no per-body outline) — unless it is a selected highlight member.
 */
export function assignOutlineTier(input: OutlineInput, settings: OutlineSettings): OutlineTier {
  if (!Number.isFinite(input.distanceMeters) || input.distanceMeters < 0) {
    throw new Error(`distanceMeters must be a non-negative finite number, got ${input.distanceMeters}`);
  }
  if (input.threat < 0 || input.threat > 1) throw new Error(`threat must be in [0,1], got ${input.threat}`);
  if (input.pixelHeight < 0) throw new Error(`pixelHeight must be non-negative, got ${input.pixelHeight}`);

  switch (input.subject) {
    case 'player':
      return 'playerStrong';
    case 'architecture':
      return 'architecture';
    case 'clutter':
      return 'clutterMinimal';
    case 'threat': {
      const tooFar = input.distanceMeters > settings.threatMaxDistanceMeters;
      const tooSmall = input.pixelHeight < settings.minReadablePixelHeight;
      if (tooFar || tooSmall) {
        // Few/no per-body outlines on distant horde; a selected member keeps a thin focal outline.
        return input.selectedHighlight ? 'threatMedium' : 'darkMass';
      }
      return 'threatMedium';
    }
  }
}

/** Screen-space outline width for a tier (px). darkMass/none have no per-body outline => 0. */
export function outlineWidthFor(tier: OutlineTier, settings: OutlineSettings): number {
  switch (tier) {
    case 'playerStrong': return settings.playerWidthPx;
    case 'threatMedium': return settings.threatWidthPx;
    case 'architecture': return settings.architectureWidthPx;
    case 'clutterMinimal': return settings.clutterWidthPx;
    case 'darkMass':
    case 'none':
      return 0;
  }
}

/**
 * Deterministically decide whether a distant horde member is one of the selectively highlighted few
 * (V20 — "selective highlighted members"). Uses a stable hash of the slot so the same members stay lit
 * frame-to-frame (no flicker). Fraction comes from config (darkMassHighlightFraction).
 */
export function isSelectedHighlight(slot: number, settings: OutlineSettings): boolean {
  if (!Number.isInteger(slot) || slot < 0) throw new Error(`slot must be a non-negative integer, got ${slot}`);
  if (settings.darkMassHighlightFraction <= 0) return false;
  if (settings.darkMassHighlightFraction >= 1) return true;
  // Stable, well-distributed hash -> [0,1) (fmix32 finalizer — avoids low-bit clustering for small slots).
  let h = slot >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  const r = h / 0x100000000;
  return r < settings.darkMassHighlightFraction;
}

/** Player gets a subtle rim accent on top of the strong outline (T32). */
export function playerRimStrength(settings: OutlineSettings): number {
  return settings.rimStrength;
}
