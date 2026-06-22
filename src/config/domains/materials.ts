// Config domain: materials. Owned by lane R (render). Self-registers on import (copies time.ts pattern).
// T32 / V20 / V29 — outline hierarchy + small-character readability. Player strongest silhouette;
// medium outlines on nearby threats; few/no per-body outlines on distant horde (dark mass); restrained
// architecture edges. Readability evaluated at expected gameplay pixel height. Every width is typed (V4).

import { num } from '../spec';
import { registerDomain } from '../registry';

export const materialsConfig = registerDomain('materials', {
  // ---- Outline widths (screen-space, pixels) per role ----
  outlineWidthPlayerPx: num({
    owner: 'materials',
    unit: 'pixels',
    doc: 'Screen-space outline width for the player — strongest silhouette in the frame (V20/T32).',
    default: 3,
    min: 0,
    max: 16,
    tiers: { 'desktop-high': 3, 'mobile-webgpu': 2 },
  }),
  outlineWidthThreatPx: num({
    owner: 'materials',
    unit: 'pixels',
    doc: 'Outline width for nearby threats (medium strength, head/limb separation).',
    default: 2,
    min: 0,
    max: 12,
  }),
  outlineWidthArchitecturePx: num({
    owner: 'materials',
    unit: 'pixels',
    doc: 'Restrained edge width for readable architecture (doors/windows/stairs/breach edges).',
    default: 1,
    min: 0,
    max: 8,
  }),
  outlineWidthClutterPx: num({
    owner: 'materials',
    unit: 'pixels',
    doc: 'Minimal edge width for clutter props (kept low to avoid visual noise).',
    default: 0.5,
    min: 0,
    max: 4,
  }),

  // ---- Player rim accent (subtle, on top of the silhouette) ----
  playerRimStrength: num({
    owner: 'materials',
    unit: 'ratio',
    doc: 'Subtle rim-light strength on the player to lift the silhouette off the crowd.',
    default: 0.35,
    min: 0,
    max: 1,
  }),

  // ---- Readability gates (evaluate at expected gameplay pixel height, T32) ----
  minReadablePixelHeight: num({
    owner: 'materials',
    unit: 'pixels',
    doc: 'Below this on-screen character pixel height, drop per-body outlines and treat as dark mass.',
    default: 24,
    min: 4,
    max: 256,
    integer: true,
    tiers: { 'desktop-high': 20, 'desktop-compat': 28, 'mobile-webgpu': 32 },
  }),
  threatOutlineMaxDistanceMeters: num({
    owner: 'materials',
    unit: 'meters',
    doc: 'Beyond this distance threats lose individual outlines and join the dark-mass treatment.',
    default: 25,
    min: 1,
    max: 200,
    tiers: { 'desktop-high': 30, 'desktop-compat': 18, 'mobile-webgpu': 14 },
  }),
  darkMassHighlightFraction: num({
    owner: 'materials',
    unit: 'ratio',
    doc: 'Fraction of distant dark-mass horde members that get a selective highlight outline.',
    default: 0.05,
    min: 0,
    max: 1,
  }),
});
