// Config domain: rendering — fire sub-domain field definitions (split from rendering.ts; no behavior change).
// Plain spec objects (NOT a registered domain); spread into registerDomain('rendering', …) by ../rendering.ts.

import { num, bool } from '../../spec';

export const fireFields = {
  // ---- FireView (RENDER lane): additive billboard FLAMES + pooled flickering point LIGHTS + faint SMOKE
  // at burning cells. Pure visual mirror of the sim's burning-cell set (V2/V3). Pooled + capped (V24),
  // distance-simplified (V8), light count capped (V8/V22), flicker damped on reduce-flashes (V29). No
  // magic numbers in fireView.ts (V4) — every flame/light/smoke tunable lives here. ----
  fireMaxCells: num({
    owner: 'rendering', unit: 'count',
    doc: 'Maximum simultaneously-tracked burning cells the FireView draws flames/lights for (pool cap, V24).',
    default: 24, min: 1, max: 256, integer: true,
    tiers: { 'desktop-high': 48, 'desktop-medium': 32, 'desktop-compat': 24, 'mobile-webgpu': 12 },
  }),
  fireQuadsPerCell: num({
    owner: 'rendering', unit: 'count',
    doc: 'Stacked/jittered additive billboard quads per burning cell at full intensity (volume).',
    default: 4, min: 1, max: 12, integer: true,
    tiers: { 'desktop-high': 6, 'desktop-medium': 4, 'desktop-compat': 3, 'mobile-webgpu': 2 },
  }),
  fireQuadCapacity: num({
    owner: 'rendering', unit: 'count',
    doc: 'Hard cap on total flame quad instances across all fires (instanced-mesh capacity, V24).',
    default: 256, min: 4, max: 4096, integer: true,
    tiers: { 'desktop-high': 512, 'desktop-medium': 256, 'desktop-compat': 128, 'mobile-webgpu': 64 },
  }),
  fireBaseSizeMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Base width/height (m) of a flame billboard quad at full intensity.',
    default: 0.9, min: 0.05, max: 8,
    tiers: { 'desktop-high': 1, 'mobile-webgpu': 0.8 },
  }),
  fireSizeJitter: num({
    owner: 'rendering', unit: 'ratio',
    doc: 'Per-quad random size variance (0 = uniform, 0.4 = +/-40%) so the flame body is not a uniform card.',
    default: 0.4, min: 0, max: 1,
  }),
  fireQuadRiseMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Vertical offset (m) added per stacked quad index — builds the flame column upward.',
    default: 0.45, min: 0, max: 4,
  }),
  fireQuadJitterMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Horizontal random jitter (m) of stacked quads around the cell centre so the column is not a flat sheet.',
    default: 0.25, min: 0, max: 4,
  }),
  fireBaseHeightMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Height (m) above the cell floor where the flame column base sits.',
    default: 0.4, min: 0, max: 8,
  }),
  fireBaseOpacity: num({
    owner: 'rendering', unit: 'ratio',
    doc: 'Base opacity of the additive flame material (additive, so this scales glow contribution).',
    default: 0.85, min: 0.01, max: 1,
  }),
  fireGrowthPerSec: num({
    owner: 'rendering', unit: 'ratio',
    doc: 'Per-second rate a freshly-ignited flame ramps its visual intensity (0..1) toward full (catch-in).',
    default: 1.5, min: 0.05, max: 20,
  }),
  fireFlickerHz: num({
    owner: 'rendering', unit: 'hz',
    doc: 'Flicker frequency (Hz) of the per-quad animated scale/opacity.',
    default: 7, min: 0.1, max: 60,
  }),
  fireFlickerAmount: num({
    owner: 'rendering', unit: 'ratio',
    doc: 'Flicker amplitude (0..1) on flame scale + brightness — the animated liveliness of the fire.',
    default: 0.35, min: 0, max: 1,
  }),
  fireReduceFlashesFlicker: num({
    owner: 'rendering', unit: 'ratio',
    doc: 'Multiplier applied to flame/light flicker amplitude when reduce-flashes is enabled (V29 damping).',
    default: 0.2, min: 0, max: 1,
  }),
  fireColorHotR: num({ owner: 'rendering', unit: 'ratio', doc: 'Deep-orange flame BASE colour (linear) R component.', default: 0.95, min: 0, max: 1 }),
  fireColorHotG: num({ owner: 'rendering', unit: 'ratio', doc: 'Deep-orange flame BASE colour (linear) G component.', default: 0.32, min: 0, max: 1 }),
  fireColorHotB: num({ owner: 'rendering', unit: 'ratio', doc: 'Deep-orange flame BASE colour (linear) B component.', default: 0.05, min: 0, max: 1 }),
  fireColorTipR: num({ owner: 'rendering', unit: 'ratio', doc: 'Yellow flame TIP colour (linear) R component.', default: 1, min: 0, max: 1 }),
  fireColorTipG: num({ owner: 'rendering', unit: 'ratio', doc: 'Yellow flame TIP colour (linear) G component.', default: 0.85, min: 0, max: 1 }),
  fireColorTipB: num({ owner: 'rendering', unit: 'ratio', doc: 'Yellow flame TIP colour (linear) B component.', default: 0.3, min: 0, max: 1 }),
  // distance-simplify (V8): full quad count within START; linearly down to one quad by END; culled past CULL.
  fireSimplifyStartMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Camera distance (m) within which a fire draws its full quad count; simplification begins beyond it (V8).',
    default: 18, min: 1, max: 500,
  }),
  fireSimplifyEndMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Camera distance (m) beyond which a fire is simplified to a single quad (V8).',
    default: 45, min: 2, max: 1000,
  }),
  fireCullDistanceMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Camera distance (m) beyond which a fire draws no flames and gets no light (V8 cull).',
    default: 70, min: 4, max: 2000,
  }),
  // pooled flickering point lights (V8/V22): only the N strongest nearby fires light the scene.
  fireLightCount: num({
    owner: 'rendering', unit: 'count',
    doc: 'Maximum simultaneous flickering point lights (only the N strongest nearby fires are lit, V8/V22).',
    default: 3, min: 0, max: 16, integer: true,
    tiers: { 'desktop-high': 4, 'desktop-medium': 3, 'desktop-compat': 2, 'mobile-webgpu': 1 },
  }),
  fireLightIntensity: num({
    owner: 'rendering', unit: 'ratio',
    doc: 'Base intensity of a fire point light at full burn intensity (scaled by intensity + flicker).',
    default: 6, min: 0, max: 200,
  }),
  fireLightRangeMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Distance (m) over which a fire point light falls off to zero.',
    default: 12, min: 0.5, max: 200,
  }),
  fireLightHeightMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Height (m) above the cell floor where a fire point light sits.',
    default: 1.2, min: 0, max: 12,
  }),
  fireLightFlickerAmount: num({
    owner: 'rendering', unit: 'ratio',
    doc: 'Flicker amplitude (0..1) on a fire point-light intensity (damped by reduce-flashes, V29).',
    default: 0.3, min: 0, max: 1,
  }),
  fireLightColorR: num({ owner: 'rendering', unit: 'ratio', doc: 'Warm fire point-light colour (linear) R component.', default: 1, min: 0, max: 1 }),
  fireLightColorG: num({ owner: 'rendering', unit: 'ratio', doc: 'Warm fire point-light colour (linear) G component.', default: 0.55, min: 0, max: 1 }),
  fireLightColorB: num({ owner: 'rendering', unit: 'ratio', doc: 'Warm fire point-light colour (linear) B component.', default: 0.2, min: 0, max: 1 }),
  // faint drifting smoke above strong fires (V56 depth policy). Skippable per tier via fireSmokeEnabled.
  fireSmokeEnabled: bool({
    owner: 'rendering',
    doc: 'Whether the FireView draws a faint drifting smoke billboard above strong fires (V56).',
    default: true,
    tiers: { 'mobile-webgpu': false },
  }),
  fireSmokeIntensityThreshold: num({
    owner: 'rendering', unit: 'ratio',
    doc: 'Minimum burn intensity (0..1) a fire needs before it grows a smoke billboard.',
    default: 0.6, min: 0, max: 1,
  }),
  fireSmokeSizeMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Width/height (m) of the faint smoke billboard above a strong fire.',
    default: 1.6, min: 0.1, max: 12,
  }),
  fireSmokeOpacity: num({
    owner: 'rendering', unit: 'ratio',
    doc: 'Opacity of the faint smoke billboard (kept low/tasteful so it never washes the scene out).',
    default: 0.18, min: 0, max: 1,
  }),
  fireSmokeRiseMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Height (m) above the cell floor where the smoke billboard centres + drifts upward.',
    default: 2, min: 0, max: 20,
  }),
  fireSmokeColorR: num({ owner: 'rendering', unit: 'ratio', doc: 'Dark smoke billboard colour (linear) R component.', default: 0.06, min: 0, max: 1 }),
  fireSmokeColorG: num({ owner: 'rendering', unit: 'ratio', doc: 'Dark smoke billboard colour (linear) G component.', default: 0.06, min: 0, max: 1 }),
  fireSmokeColorB: num({ owner: 'rendering', unit: 'ratio', doc: 'Dark smoke billboard colour (linear) B component.', default: 0.07, min: 0, max: 1 }),
};
