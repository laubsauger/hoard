// Config domain: UI. Owned by lane U.
// V11 — high-frequency view snapshots into Zustand MUST be throttled/event-gated.
// These throttle intervals are the typed governors for engine->store snapshot publishing.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const uiConfig = registerDomain('UI', {
  playerSnapshotThrottleMs: num({
    owner: 'UI',
    unit: 'ms',
    doc: 'Minimum interval between player-view snapshot pushes to the store (V11 health interp throttle).',
    default: 100,
    min: 16,
    max: 1000,
    integer: true,
  }),
  hordeSnapshotThrottleMs: num({
    owner: 'UI',
    unit: 'ms',
    doc: 'Minimum interval between horde/map pressure snapshot pushes (V11).',
    default: 250,
    min: 16,
    max: 2000,
    integer: true,
  }),
  targetingSnapshotThrottleMs: num({
    owner: 'UI',
    unit: 'ms',
    doc: 'Minimum interval between targeting-reticle snapshot pushes (V11 cursor targeting gate).',
    default: 50,
    min: 8,
    max: 500,
    integer: true,
  }),
  diagnosticsSnapshotThrottleMs: num({
    owner: 'UI',
    unit: 'ms',
    doc: 'Minimum interval between diagnostics-counter pushes to the store.',
    default: 500,
    min: 100,
    max: 5000,
    integer: true,
  }),
  uiScaleDefault: num({
    owner: 'UI',
    unit: 'ratio',
    doc: 'Default scalable-UI factor (V29 scalable UI). Persisted user override lives in the settings store.',
    default: 1,
    min: 0.75,
    max: 2,
  }),
  interactionPromptAnchorHeightMeters: num({
    owner: 'UI',
    unit: 'meters',
    doc: 'World height above the interactable used to anchor the world-floating "{F} to {action}" prompt (T113) — ~chest/handle height so the bubble sits beside the object, not on the floor.',
    default: 1.6,
    min: 0,
    max: 5,
  }),
  interactionPromptOffsetPx: num({
    owner: 'UI',
    unit: 'pixels',
    doc: 'Screen-px the world-anchored interaction prompt is lifted ABOVE its projected anchor so it floats over the item (T113).',
    default: 18,
    min: 0,
    max: 200,
    integer: true,
  }),
  interactionPromptMarginPx: num({
    owner: 'UI',
    unit: 'pixels',
    doc: 'Minimum px from the viewport edges when clamping the world-anchored interaction prompt on-screen (T113).',
    default: 12,
    min: 0,
    max: 200,
    integer: true,
  }),
});
