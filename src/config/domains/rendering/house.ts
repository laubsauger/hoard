// Config domain: rendering — house sub-domain field definitions (split from rendering.ts; no behavior change).
// Plain spec objects (NOT a registered domain); spread into registerDomain('rendering', …) by ../rendering.ts.

import { num, bool } from '../../spec';

export const houseFields = {
  // ---- V25 capability gates (R15 GPU adapter limits) ----
  // For each tier we resolve the MINIMUM adapter limit required to be eligible for that tier.
  // detectQualityTier picks the highest tier whose every minimum is satisfied; mobile = floor.
  minMaxTextureDimension2D: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Minimum GPUSupportedLimits.maxTextureDimension2D required to qualify for a tier (V25/R15).',
    default: 4096, // mobile-webgpu floor
    min: 2048,
    max: 32768,
    integer: true,
    tiers: { 'desktop-high': 16384, 'desktop-medium': 8192, 'desktop-compat': 8192, 'mobile-webgpu': 4096 },
  }),
  minMaxBufferSize: num({
    owner: 'rendering',
    unit: 'bytes',
    doc: 'Minimum GPUSupportedLimits.maxBufferSize required to qualify for a tier (V25/R15).',
    default: 134217728, // 128 MiB mobile floor
    min: 67108864,
    max: 8589934592,
    integer: true,
    tiers: {
      'desktop-high': 1073741824, // 1 GiB
      'desktop-medium': 536870912, // 512 MiB
      'desktop-compat': 268435456, // 256 MiB
      'mobile-webgpu': 134217728, // 128 MiB
    },
  }),
  minMaxComputeWorkgroupStorageSize: num({
    owner: 'rendering',
    unit: 'bytes',
    doc: 'Minimum GPUSupportedLimits.maxComputeWorkgroupStorageSize required to qualify for a tier (V25/R15).',
    default: 16384, // mobile floor (WebGPU spec minimum)
    min: 16384,
    max: 65536,
    integer: true,
    tiers: {
      'desktop-high': 32768,
      'desktop-medium': 32768,
      'desktop-compat': 16384,
      'mobile-webgpu': 16384,
    },
  }),
  // ---- V25 startup micro-benchmark gates (measured perf, NOT browser name) ----
  // detectTierFromProbe combines these with the adapter-limit gates above: a device qualifies for a
  // tier only if it BOTH satisfies that tier's minimum adapter limits AND its measured probe frame is
  // within budget AND its measured fill-rate score clears the floor. Measured perf can only DEMOTE
  // below the limit ceiling, never promote above it. Below the mobile floor → explicit error (V4).
  probeGpuFrameBudgetMs: num({
    owner: 'rendering',
    unit: 'ms',
    doc: 'Max measured GPU frame time (ms) at the fixed reference probe scene to qualify for a tier (V25).',
    default: 24, // mobile-webgpu ceiling — slower than this fails every tier
    min: 1,
    max: 100,
    tiers: {
      'desktop-high': 6,
      'desktop-medium': 10,
      'desktop-compat': 16,
      'mobile-webgpu': 24,
    },
  }),
  probeMinFillRateScore: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Min measured device-independent fill/throughput score from the startup probe to qualify for a tier (V25).',
    default: 10, // mobile floor
    min: 0,
    max: 1000,
    tiers: {
      'desktop-high': 100,
      'desktop-medium': 60,
      'desktop-compat': 30,
      'mobile-webgpu': 10,
    },
  }),
  // ---- Output / frame ----
  pixelRatioMax: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Upper clamp on devicePixelRatio applied to the renderer (V22 scaling order).',
    default: 1.5,
    min: 0.5,
    max: 3,
    tiers: { 'desktop-high': 2, 'desktop-medium': 1.5, 'desktop-compat': 1, 'mobile-webgpu': 1.5 },
  }),
  // ---- Device-loss recovery (V23) ----
  deviceLossMaxRecoveries: num({
    owner: 'rendering',
    unit: 'count',
    doc: 'Max automatic WebGPU device-loss recoveries before session-safe shutdown (V23).',
    default: 3,
    min: 0,
    max: 10,
    integer: true,
  }),
  // ---- Visibility / cutaway (T28 / V20): roof+upper-wall fade, base preserved, interiors stay hidden ----
  roofFadeSeconds: num({
    owner: 'rendering',
    unit: 'seconds',
    doc: 'Time to fade a roof/upper-wall section in or out as occlusion state changes (V20).',
    default: 0.25,
    min: 0,
    max: 5,
  }),
  wallPanelThicknessMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Thickness of a wall-shell panel (≪ navCell). Walls are thin oriented shells on exposed cell edges, not cell-filling blocks (B3).',
    default: 0.25,
    min: 0.02,
    max: 2,
  }),
  wallBasePreservedHeightMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Wall height (from floor up) always kept opaque to read enclosure + breach state (V20).',
    default: 1.2,
    min: 0.1,
    max: 10,
  }),
  cutawayCameraFacingDotThreshold: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'DIRECTIONAL cutaway (T82/V58): an upper wall fades only when its outward normal turns toward the camera — dot(outwardNormal, towardCamera) > this threshold. Walls facing away (the FAR walls) stay opaque so enclosure still reads, so the room is never reduced to a roofless open box. Cosine in [-1,1]; ~0.2 fades the near walls between camera + player while keeping the far + grazing walls (V58).',
    default: 0.2,
    min: -1,
    max: 1,
  }),
  exteriorCutawayAdjacencyMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'OUTSIDE-WALL cutaway (V62): when the player stands OUTSIDE a building within this distance of one of its exterior walls AND that wall lies between the camera and the player (the wall plane separates them), the near wall section fades so the player is not hidden behind it. Purely a VIEW aid — structural LOS (and therefore crowd reveal) is unchanged (V63).',
    default: 2,
    min: 0,
    max: 20,
  }),
  cutawayMinOpacity: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'SLIVER floor (V65): a cutaway-faded roof/upper/interior wall fades to THIS opacity, NOT to 0 — a low-opacity hint of the wall stays so the player keeps spatial orientation (sees the room outline they are inside). 0 = fully vanish (old behaviour); ~0.12 leaves a readable sliver. The fade TARGET for any occluding surface becomes this value instead of 0.',
    default: 0.12,
    min: 0,
    max: 1,
  }),
  cutawayOccluderLateralSpanMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'GENERIC player↔camera occlusion (V66): a tagged wall (interior included) fades only when the player→camera segment crosses its plane within this lateral distance of the wall centre — so a wall whose INFINITE plane the segment happens to cross far off to the side never fades. Bounds the generic "between player and camera" test to walls actually on the sightline. ~half a building span.',
    default: 10,
    min: 0.5,
    max: 60,
  }),
  cutawayXrayRadiusMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'X-RAY BUBBLE radius (V74): a Project-Zomboid-style cutaway bubble around the player. An occluding surface fades ONLY when its NEAREST point is within this distance of the player — so the cutaway follows the player everywhere and dissolves nearby occluders on the camera→player sightline (works behind ANY wall — neighbour/exterior included — not just the building the player occupies), yet stays radius-selective (a wall a few metres further back stays solid). A roof occludes from above so being inside the bubble is enough; a wall must ALSO lie between the player and the camera (V66). A tactical few metres — large enough to clear a typical house half-depth so the room you stand in reveals, small enough that the district still reads as solid streets. Pure VIEW aid, never touches the structural/nav grid (V63).',
    default: 8,
    min: 1,
    max: 40,
  }),
  cutawaySightlineMarginMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Grazing margin (m) added to a wall footprint when testing whether the player→camera SIGHTLINE crosses it (V74 x-ray, normal-free segment-vs-AABB). The sightline is really a thin cone around the body, so a thin wall the line just clips still counts as occluding. Small — too large over-fades neighbours.',
    default: 0.45,
    min: 0,
    max: 3,
  }),
  upperWallFadeStartHeightMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Wall height above which sections may fade when they occlude the camera view (V20).',
    default: 1.8,
    min: 0.2,
    max: 20,
  }),
  // ---- T87 residential house render dressing (clapboard/ivy/debris/porch/chimney sizing) ----
  // Geometric scales for the believable-house look; the per-house VARIATION/DISARRAY probabilities live in
  // the `world` domain, these are the render-side prop dimensions (V4).
  houseClapboardSpacingMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Vertical spacing between horizontal clapboard/lap-siding trim lines on house walls (T87).',
    default: 0.5, min: 0.15, max: 2,
  }),
  /** How dark the lap-siding shadow groove gets at each board seam (fraction the wall tint is multiplied down). */
  houseClapboardGrooveDarken: num({
    owner: 'rendering', unit: 'ratio',
    doc: 'Darken amount of the lap-siding shadow groove at each board seam (TSL wall colorNode banding).',
    default: 0.34, min: 0, max: 1,
  }),
  /** Width of the shadow groove as a fraction of one clapboard spacing (the thin dark line under each board lip). */
  houseClapboardGrooveWidthRatio: num({
    owner: 'rendering', unit: 'ratio',
    doc: 'Width of the lap-siding shadow groove as a fraction of one board spacing (thin dark line per seam).',
    default: 0.16, min: 0.01, max: 0.5,
  }),
  houseIvyPatchMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Edge size of one instanced ivy/overgrowth patch creeping a house wall (T87).',
    default: 0.7, min: 0.2, max: 3,
  }),
  houseDebrisMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Edge size of one instanced debris/rubble clump at a ruined house base (T87).',
    default: 0.55, min: 0.1, max: 3,
  }),
  housePorchHeightMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Height of a front-porch roof above its deck (post length) (T87).',
    default: 2.4, min: 1, max: 5,
  }),
  houseChimneyMeters: num({
    owner: 'rendering', unit: 'meters',
    doc: 'Plan edge size of a house chimney stack (T87).',
    default: 0.7, min: 0.2, max: 2,
  }),
  // ---- Fog of war (T109 / V73) — a ground-plane overlay darkening UNEXPLORED + EXPLORED-but-not-visible
  //      world cells, driven by a coarse per-cell visited+visible grid (render/world/fogOfWar.ts). The dim
  //      levels below are the overlay opacities; a CURRENTLY-VISIBLE cell is always fully clear (0). Pure VIEW
  //      — never mutates sim/nav (V2/V63); allocation-free per frame (V24). ----
  fogOfWarEnabled: bool({
    owner: 'rendering',
    doc: 'Master toggle for the fog-of-war ground overlay (T109). Off renders the world fully un-fogged. Disabled on the mobile tier (the per-frame grid sweep is an early scaling victim).',
    default: true,
    tiers: { 'mobile-webgpu': false },
  }),
  fogOfWarUnexploredDim: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Overlay opacity for a NEVER-seen (unexplored) world cell — the darkest fog layer (T109/V73).',
    default: 0.85,
    min: 0,
    max: 1,
  }),
  fogOfWarExploredDim: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Overlay opacity for an EXPLORED-but-not-currently-visible cell — the dim "memory" layer (T109/V73).',
    default: 0.5,
    min: 0,
    max: 1,
  }),
  fogOfWarFadePerSecond: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Per-second exponential approach rate for each fog cell overlay opacity toward its target so cells fade between states (V73) instead of hard-popping. Mirrors the lighting fog-distance smoothing pattern.',
    default: 6,
    min: 0.1,
    max: 60,
  }),
  fogOfWarHeightMeters: num({
    owner: 'rendering',
    unit: 'meters',
    doc: 'Height the fog overlay plane sits above the base ground so it composites over the ground paint without z-fighting (T109).',
    default: 0.06,
    min: 0,
    max: 2,
  }),
  fogOfWarColor: num({
    owner: 'rendering',
    unit: 'ratio',
    doc: 'Fog overlay tint as a packed 0xRRGGBB hex (cool near-black), applied at the per-cell dim opacity (T109).',
    default: 0x05070a,
    min: 0,
    max: 0xffffff,
    integer: true,
  }),
};
