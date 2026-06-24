// Config domain: debug. Owned by lane X (diagnostics). T35 / V4 / V27.
// Governs the diagnostics overlay + collector behaviour. Every value is typed with
// unit/owner/default/range/tier — no magic numbers buried in overlay or collector code.
// Importing this module self-registers the domain (registry singleton, additive per §T protocol).

import { num, bool } from '../spec';
import { registerDomain } from '../registry';

export const debugConfig = registerDomain('debug', {
  /** Whether the diagnostics overlay starts visible for a given build/tier. Off by default on mobile. */
  overlayEnabledByDefault: bool({
    owner: 'debug',
    doc: 'Diagnostics overlay visible on startup for this build/tier (V27 diagnostics view).',
    default: true,
    tiers: { 'mobile-webgpu': false },
  }),
  /** Ring-buffer window over which frame-time percentiles (median/95/99) are computed. */
  percentileWindowSize: num({
    owner: 'debug',
    unit: 'count',
    doc: 'Number of recent frame samples kept in the percentile ring buffer (§V profiling).',
    default: 120,
    min: 8,
    max: 4096,
    integer: true,
    tiers: { 'mobile-webgpu': 60, 'desktop-high': 240 },
  }),
  /** Minimum interval between collector->store snapshot publishes (V11 high-freq UI throttle). */
  refreshThrottleMs: num({
    owner: 'debug',
    unit: 'ms',
    doc: 'Minimum interval between diagnostics-snapshot publishes to the overlay store (V11).',
    default: 250,
    min: 50,
    max: 5000,
    integer: true,
  }),
  /** Bounded count of recent GC/save markers retained for the overlay timeline. */
  markerHistorySize: num({
    owner: 'debug',
    unit: 'count',
    doc: 'Maximum number of recent GC/save markers kept by the collector (bounded, no unbounded growth).',
    default: 32,
    min: 1,
    max: 1024,
    integer: true,
  }),
  /**
   * §V78 — ray SEGMENTS fanned across each agent's FOV when the dev overlay draws the RAYCAST-OCCLUDED
   * vision/sight polygon (player vision cone + zombie sight cones). More segments = a smoother shadow
   * edge around corners but more per-frame raycasts; bounded so the overlay stays cheap (dev-only).
   */
  visionDebugRaySegments: num({
    owner: 'debug',
    unit: 'count',
    doc: 'Rays fanned across each agent FOV for the occluded vision-cone debug overlay (§V78); more = smoother shadow edge, more raycasts.',
    default: 24,
    min: 4,
    max: 128,
    integer: true,
    tiers: { 'mobile-webgpu': 16, 'desktop-high': 32 },
  }),
  /**
   * §V78 — world-space stroke width (m) of the occluded vision-polygon OUTLINE. A thin fixed line in
   * world meters (the rim points are already world-space, so it never fattens with range).
   */
  visionDebugStrokeMeters: num({
    owner: 'debug',
    unit: 'meters',
    doc: 'World-space stroke width of the occluded vision-cone debug outline (§V78) — a thin fixed line.',
    default: 0.05,
    min: 0.01,
    max: 1,
  }),
});
