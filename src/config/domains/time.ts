// Config domain: time. Owned by lane F (core). Other lanes add their own domain files.
// V12 — authoritative sim runs a fixed tick independent of render rate.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const timeConfig = registerDomain('time', {
  /** Authoritative simulation tick rate. Render interpolates between ticks (V12). */
  tickHz: num({
    owner: 'time',
    unit: 'hz',
    doc: 'Fixed authoritative simulation ticks per second.',
    default: 30,
    min: 10,
    max: 120,
    integer: true,
    tiers: { 'mobile-webgpu': 20 },
  }),
  /** Upper bound on how much real time one update() call may consume in catch-up ticks. */
  maxFrameSeconds: num({
    owner: 'time',
    unit: 'seconds',
    doc: 'Clamp on accumulated real time per frame to avoid spiral-of-death after a stall.',
    default: 0.25,
    min: 0.05,
    max: 1,
  }),
  /** Hard cap on catch-up ticks processed in a single frame. */
  maxCatchUpTicks: num({
    owner: 'time',
    unit: 'count',
    doc: 'Max fixed ticks integrated in one frame before dropping surplus time.',
    default: 8,
    min: 1,
    max: 60,
    integer: true,
  }),
});
