// Config domain: input. Owned by lane U.
// V29 — full input remap + separate sensitivity. Wave-1 covers camera control sensitivities.
// Bindings themselves live as runtime state in the input store; these are the typed sensitivity governors.

import { bool, num } from '../spec';
import { registerDomain } from '../registry';

export const inputConfig = registerDomain('input', {
  zoomSensitivity: num({
    owner: 'input',
    unit: 'ratio',
    doc: 'Multiplier applied to raw wheel/zoom delta before clamping (V29 separate sensitivity).',
    default: 1,
    min: 0.1,
    max: 5,
  }),
  invertZoom: bool({
    owner: 'input',
    doc: 'Invert zoom direction for wheel input (accessibility / preference).',
    default: false,
  }),
  rotateRepeatMs: num({
    owner: 'input',
    unit: 'ms',
    doc: 'Minimum interval between repeated 90-degree rotation steps while a rotate key is held.',
    default: 180,
    min: 50,
    max: 1000,
    integer: true,
  }),
  pointerSensitivity: num({
    owner: 'input',
    unit: 'ratio',
    doc: 'Pointer movement sensitivity multiplier (V29 separate sensitivity).',
    default: 1,
    min: 0.1,
    max: 5,
  }),
});
