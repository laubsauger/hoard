// Config domain: postFX. Owned by lane R (render). Self-registers on import (copies time.ts pattern).
// T31 / V8 / V22 / V29 — stable-outline AA, authored color grading, selective bloom, grounding AO,
// depth+fog horde separation, dynamic resolution (engages BEFORE dropping sim correctness), and sparse
// accessible damage feedback. Every tunable typed (V4); invalid content throws at registration.

import { num, enumOf } from '../spec';
import { registerDomain } from '../registry';

export const postFXConfig = registerDomain('postFX', {
  // ---- Anti-aliasing / reconstruction (must keep outlines stable, T31/T32) ----
  antialiasMode: enumOf({
    owner: 'postFX',
    doc: 'AA / reconstruction mode chosen for stable thin outlines per tier.',
    values: ['taa', 'smaa', 'fxaa', 'none'] as const,
    default: 'smaa',
    tiers: { 'desktop-high': 'taa', 'desktop-medium': 'smaa', 'desktop-compat': 'fxaa', 'mobile-webgpu': 'fxaa' },
  }),

  // ---- Selective bloom (practical lights / wet highlights ONLY, never universal haze) ----
  bloomThreshold: num({
    owner: 'postFX',
    unit: 'ratio',
    doc: 'Luminance threshold above which bloom applies — high so only bright practicals bloom (T31).',
    default: 1.1,
    min: 0,
    max: 10,
  }),
  bloomIntensity: num({
    owner: 'postFX',
    unit: 'ratio',
    doc: 'Bloom contribution strength for qualifying highlights.',
    default: 0.4,
    min: 0,
    max: 4,
  }),

  // ---- Grounding ambient occlusion (post pass distinct from near-player AO) ----
  groundingAoStrength: num({
    owner: 'postFX',
    unit: 'ratio',
    doc: 'Strength of the grounding screen-space AO pass that seats characters in the scene.',
    default: 0.5,
    min: 0,
    max: 1,
    tiers: { 'desktop-high': 0.6, 'desktop-compat': 0.3, 'mobile-webgpu': 0 },
  }),

  // ---- Depth + fog horde-layer separation ----
  hordeDepthSeparationMeters: num({
    owner: 'postFX',
    unit: 'meters',
    doc: 'Depth band over which fog/desaturation separates the horde layer from the foreground.',
    default: 30,
    min: 1,
    max: 300,
  }),

  // ---- Dynamic resolution (V22: engages BEFORE failure, BEFORE dropping sim correctness) ----
  dynamicResolutionFloor: num({
    owner: 'postFX',
    unit: 'ratio',
    doc: 'Lowest internal render-resolution scale dynamic resolution may reach (V22 #1).',
    default: 0.6,
    min: 0.25,
    max: 1,
    tiers: { 'desktop-high': 0.7, 'desktop-compat': 0.5, 'mobile-webgpu': 0.5 },
  }),
  dynamicResolutionStep: num({
    owner: 'postFX',
    unit: 'ratio',
    doc: 'Per-adjustment change in internal resolution scale when reacting to GPU pressure.',
    default: 0.05,
    min: 0.01,
    max: 0.5,
  }),
  gpuPressureEngageThreshold: num({
    owner: 'postFX',
    unit: 'ratio',
    doc: 'Normalized GPU frame-time pressure (>1 = over budget) above which scaling begins — <1 so it engages BEFORE failure (V22).',
    default: 0.9,
    min: 0.5,
    max: 1,
  }),
  gpuPressureReleaseThreshold: num({
    owner: 'postFX',
    unit: 'ratio',
    doc: 'Pressure below which dynamic resolution recovers toward 1.0 (hysteresis to avoid oscillation).',
    default: 0.7,
    min: 0.3,
    max: 1,
  }),

  // ---- Sparse accessible damage feedback (V29 — caps; runtime accessibility multipliers injected) ----
  damageShakeMax: num({
    owner: 'postFX',
    unit: 'ratio',
    doc: 'Maximum camera-shake amplitude at full damage feedback before accessibility scaling (V29).',
    default: 0.4,
    min: 0,
    max: 1,
  }),
  damageVignetteMax: num({
    owner: 'postFX',
    unit: 'ratio',
    doc: 'Maximum damage vignette strength before accessibility scaling.',
    default: 0.6,
    min: 0,
    max: 1,
  }),
  damageBlurMax: num({
    owner: 'postFX',
    unit: 'ratio',
    doc: 'Maximum radial-blur strength on heavy damage before accessibility scaling.',
    default: 0.3,
    min: 0,
    max: 1,
  }),
  damageChromaticMax: num({
    owner: 'postFX',
    unit: 'ratio',
    doc: 'Maximum chromatic-aberration strength on damage before accessibility scaling.',
    default: 0.25,
    min: 0,
    max: 1,
  }),
});
