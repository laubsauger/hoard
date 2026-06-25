// Config domain: rendering — Ground Truth Ambient Occlusion (GTAO) post-process sub-domain (V4).
// Plain spec objects (NOT a registered domain); spread into registerDomain('rendering', …) by ../rendering.ts.
// Screen-space contact-shadow AO applied INSIDE the WebGPU backend's PostProcessing pipeline (the only place
// `new WebGPURenderer()` lives). Grounds the world: darkens corners, wall/floor seams, under furniture, between
// close objects. Multiplies into scene colour in LINEAR space BEFORE tone mapping, so it never double-tonemaps.
// Every tunable the AO graph reads lives here — NO magic numbers in the engine (V4), resolved per tier.

import { bool, num } from '../../spec';

export const aoFields = {
  // Master enable, resolved per tier. ON across the desktop tiers (the premium, grounded look); OFF on the
  // lowest tier (mobile-webgpu) where the extra full-screen depth/normal prepass + AO pass is too costly.
  // A live `ao` debug flag gates this further at runtime (dev toggle); the effective AO = aoEnabled && flag.
  aoEnabled: bool({
    owner: 'rendering',
    doc: 'Enable GTAO ambient-occlusion post-processing (contact shadows in corners / under furniture / at seams). ON on desktop tiers; OFF on the lowest (mobile-webgpu) tier for perf. A runtime `ao` debug flag toggles it further.',
    default: true,
    tiers: { 'mobile-webgpu': false },
  }),
  aoRadius: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'World-space sampling radius (m) of the GTAO occlusion search. Larger = broader, softer occlusion that reaches further from seams; smaller = tight contact shadows only. Kept modest so AO reads as grounding contact shadow, not a global darkening.',
    default: 0.5,
    min: 0.05,
    max: 4,
  }),
  aoSamples: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Number of GTAO horizon samples per pixel. Higher = smoother/less noisy AO at higher GPU cost. Reduced on the lower desktop tier to keep the prepass cheap.',
    default: 16,
    min: 4,
    max: 32,
    integer: true,
    tiers: { 'desktop-medium': 12, 'desktop-compat': 8 },
  }),
  aoDistanceExponent: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'GTAO distance falloff exponent (attenuates AO with view distance). Recommended range [1,2]; 1 keeps AO uniform across depth.',
    default: 1,
    min: 0.5,
    max: 4,
  }),
  aoScale: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'GTAO scale multiplier on the raw occlusion term inside the AO pass (shapes how aggressively horizons darken before the intensity blend).',
    default: 1,
    min: 0.1,
    max: 4,
  }),
  aoThickness: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'GTAO surface thickness heuristic — how far behind a sampled horizon geometry is assumed to extend. Higher reduces haloing/light-leak behind thin objects; too high over-occludes.',
    default: 1,
    min: 0.1,
    max: 4,
  }),
  aoIntensity: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'How strongly the resolved AO darkens the scene (0 = no darkening, 1 = full GTAO term). Blended as mix(1, aoTerm, intensity) so corners/seams deepen TASTEFULLY without crushing the image to a black halo.',
    default: 0.9,
    min: 0,
    max: 1,
  }),
};
