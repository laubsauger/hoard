// Config domain: rendering — highlight sub-domain field definitions (split from rendering.ts; no behavior change).
// Plain spec objects (NOT a registered domain); spread into registerDomain('rendering', …) by ../rendering.ts.

import { num } from '../../spec';

export const highlightFields = {
  // ---- Active-interactable HIGHLIGHT (T60/V29): a glowing wireframe outline on the NEAREST interactable in
  // reach (the same target the prompt + wheel act on) so the player sees WHICH object the prompt means. One
  // at a time. COLOUR-CODED by kind. depthTest ON so walls occlude it correctly (V56 — never depthTest:false);
  // gently pulsing, damped to a steady glow when reduce-flashes / reduce-motion is set (V29). No magic
  // numbers in highlightView.ts (V4) — every appearance tunable lives here. ----
  highlightPulseHz: num({
    owner: 'rendering', unit: 'hz',
    doc: 'Pulse frequency (Hz) of the active-interactable highlight glow (T60/V29).',
    default: 1.4, min: 0.05, max: 10,
  }),
  highlightPulseMinIntensity: num({
    owner: 'rendering', unit: 'ratio',
    doc: 'Trough opacity/glow (0..1) of the pulsing highlight outline (T60/V29).',
    default: 0.4, min: 0, max: 1,
  }),
  highlightPulseMaxIntensity: num({
    owner: 'rendering', unit: 'ratio',
    doc: 'Peak opacity/glow (0..1) of the pulsing highlight outline (T60/V29).',
    default: 0.9, min: 0, max: 1,
  }),
  highlightReducedIntensity: num({
    owner: 'rendering', unit: 'ratio',
    doc: 'Steady opacity/glow (0..1) the highlight holds when reduce-flashes / reduce-motion damps the pulse (V29).',
    default: 0.7, min: 0, max: 1,
  }),
  // per-kind outline colours (linear RGB). Doors blue, containers amber, corpses violet, windows cyan, walls red.
  highlightDoorColorR: num({ owner: 'rendering', unit: 'ratio', doc: 'Door highlight colour (linear) R.', default: 0.25, min: 0, max: 1 }),
  highlightDoorColorG: num({ owner: 'rendering', unit: 'ratio', doc: 'Door highlight colour (linear) G.', default: 0.6, min: 0, max: 1 }),
  highlightDoorColorB: num({ owner: 'rendering', unit: 'ratio', doc: 'Door highlight colour (linear) B.', default: 1, min: 0, max: 1 }),
  highlightContainerColorR: num({ owner: 'rendering', unit: 'ratio', doc: 'Container highlight colour (linear) R.', default: 1, min: 0, max: 1 }),
  highlightContainerColorG: num({ owner: 'rendering', unit: 'ratio', doc: 'Container highlight colour (linear) G.', default: 0.72, min: 0, max: 1 }),
  highlightContainerColorB: num({ owner: 'rendering', unit: 'ratio', doc: 'Container highlight colour (linear) B.', default: 0.2, min: 0, max: 1 }),
  highlightCorpseColorR: num({ owner: 'rendering', unit: 'ratio', doc: 'Corpse highlight colour (linear) R.', default: 0.7, min: 0, max: 1 }),
  highlightCorpseColorG: num({ owner: 'rendering', unit: 'ratio', doc: 'Corpse highlight colour (linear) G.', default: 0.4, min: 0, max: 1 }),
  highlightCorpseColorB: num({ owner: 'rendering', unit: 'ratio', doc: 'Corpse highlight colour (linear) B.', default: 0.9, min: 0, max: 1 }),
  highlightWindowColorR: num({ owner: 'rendering', unit: 'ratio', doc: 'Window highlight colour (linear) R.', default: 0.3, min: 0, max: 1 }),
  highlightWindowColorG: num({ owner: 'rendering', unit: 'ratio', doc: 'Window highlight colour (linear) G.', default: 0.9, min: 0, max: 1 }),
  highlightWindowColorB: num({ owner: 'rendering', unit: 'ratio', doc: 'Window highlight colour (linear) B.', default: 0.85, min: 0, max: 1 }),
  highlightStructureColorR: num({ owner: 'rendering', unit: 'ratio', doc: 'Structure/wall highlight colour (linear) R.', default: 1, min: 0, max: 1 }),
  highlightStructureColorG: num({ owner: 'rendering', unit: 'ratio', doc: 'Structure/wall highlight colour (linear) G.', default: 0.3, min: 0, max: 1 }),
  highlightStructureColorB: num({ owner: 'rendering', unit: 'ratio', doc: 'Structure/wall highlight colour (linear) B.', default: 0.2, min: 0, max: 1 }),
  highlightOutlineWidthMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Width (m) the L4D-style silhouette rim-GLOW sits proud of the surface, inflated along the mesh normals around the active interactable (T113/T115/V79/V81). A FRESNEL RIM shell cloned from the real render mesh(es) — it HUGS the mesh shape, never a box. A SMIDGE proud so the rim reads clearly. ALWAYS-ON-TOP: depthTest OFF so it is never occluded (V81 — a deliberate exception to V56 for this readability aid; the fresnel keeps it an edge, not a fill, so depth-off is safe).',
    default: 0.1, min: 0.005, max: 0.5,
  }),
  highlightRimFresnelPower: num({
    owner: 'rendering', unit: 'ratio',
    doc: 'Fresnel exponent for the active-interactable rim GLOW (T115/V81). The shell `colorNode` is brightness-gated by `pow(1 - |dot(normalWorld, viewDir)|, power)` so it lights ONLY the silhouette EDGE (an outline), not the full face — higher tightens the edge. This is what makes the always-on-top (depthTest:false) glow read as a thin outline rather than a filled additive blob.',
    default: 3, min: 0.5, max: 12,
  }),
};
