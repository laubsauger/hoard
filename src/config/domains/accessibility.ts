// Config domain: accessibility. Owned by lane U/A (cross-cut). V29 — the full accessibility surface.
// These are the TYPED DEFAULTS for every V29 setting; the user-overridable live values live in the
// persisted settings store (src/stores/settings.ts) and are seeded from here. Render systems consume the
// resolved values (gore intensity, outline strength, camera shake, flash/motion reduction) — never a
// hardcoded magic number (V4). Booleans default to the least-surprising baseline; intensities default to
// full (1) so the reference experience is unchanged until the player opts into a reduction.

import { bool, num } from '../spec';
import { registerDomain } from '../registry';

export const accessibilityConfig = registerDomain('accessibility', {
  /** Selective-outline strength multiplier (V29). 0 disables per-body outlines, 1 = full. */
  outlineStrengthDefault: num({
    owner: 'accessibility',
    unit: 'ratio',
    doc: 'Default outline-strength multiplier applied to the selective-outline hierarchy (V29).',
    default: 1,
    min: 0,
    max: 1,
  }),
  /** Target-highlight strength for the currently selected/aimed threat (V29). */
  targetHighlightStrengthDefault: num({
    owner: 'accessibility',
    unit: 'ratio',
    doc: 'Default highlight strength for the actively targeted threat (V29).',
    default: 1,
    min: 0,
    max: 1,
  }),
  /** Gore-intensity multiplier (V29). 0 fully suppresses gore, 1 = full wet response. */
  goreIntensityDefault: num({
    owner: 'accessibility',
    unit: 'ratio',
    doc: 'Default gore-intensity multiplier fed to the gore system (V29). 0 suppresses gore entirely.',
    default: 1,
    min: 0,
    max: 1,
  }),
  /** Camera-shake multiplier (V29). 0 disables shake, 1 = full. */
  cameraShakeScaleDefault: num({
    owner: 'accessibility',
    unit: 'ratio',
    doc: 'Default camera-shake multiplier fed to damage feedback (V29).',
    default: 1,
    min: 0,
    max: 1,
  }),
  /** Reduce/suppress full-screen flashes + chromatic aberration (photosensitivity, V29). */
  reduceFlashesDefault: bool({
    owner: 'accessibility',
    doc: 'Default for flash/chromatic-aberration reduction (photosensitivity, V29).',
    default: false,
  }),
  /** Global motion reduction — damps blur, slows roof/UI transitions, zeroes idle camera drift (V29). */
  reduceMotionDefault: bool({
    owner: 'accessibility',
    doc: 'Default for global motion reduction (V29).',
    default: false,
  }),
  /** High-contrast UI text + chrome (V29). */
  highContrastDefault: bool({
    owner: 'accessibility',
    doc: 'Default for high-contrast UI text/chrome (V29).',
    default: false,
  }),
  /** Scalable-UI factor default (V29). The live override is persisted in the settings store. */
  uiScaleDefault: num({
    owner: 'accessibility',
    unit: 'ratio',
    doc: 'Default scalable-UI factor (V29 scalable UI).',
    default: 1,
    min: 0.75,
    max: 2,
  }),
  /** Color-INDEPENDENT damage/interaction indicators — shape+fill, not hue alone (V29). On by default. */
  colorIndependentIndicatorsDefault: bool({
    owner: 'accessibility',
    doc: 'Default for color-independent damage/interaction indicators (shape+fill, V29).',
    default: true,
  }),
  /** Visual indicators / captions for audio cues: alarms, breaking glass, directional threats (V29). */
  audioCueIndicatorsDefault: bool({
    owner: 'accessibility',
    doc: 'Default for visual indicators of audio cues (alarms/glass/directional threats, V29).',
    default: false,
  }),
  /** Subtitles for spoken/diegetic audio (V29). */
  subtitlesDefault: bool({
    owner: 'accessibility',
    doc: 'Default for subtitles (V29).',
    default: false,
  }),
  /** Optional pause/slowdown for inventory + complex contextual actions (single-player, V29). */
  pauseForComplexActionsDefault: bool({
    owner: 'accessibility',
    doc: 'Default for optional pause/slowdown during inventory + complex actions (single-player, V29).',
    default: false,
  }),
  /** Time-scale applied while a complex action is open when pause/slowdown is enabled (V29). 1 = none. */
  slowdownFactorDefault: num({
    owner: 'accessibility',
    unit: 'ratio',
    doc: 'Sim time-scale while a complex action is open when pause/slowdown is enabled (V29). 0 = full pause.',
    default: 0.25,
    min: 0,
    max: 1,
  }),
});
