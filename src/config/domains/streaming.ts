// Config domain: streaming. Owned by lane S. Chunk streaming lifecycle budgets (T14).
// V24 — resource lifecycle is bounded + explicit; cooling/eviction governed by config, not magic numbers.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const streamingConfig = registerDomain('streaming', {
  /** Hard cap on chunks resident at high-detail simultaneously (memory ceiling). */
  maxHighDetailChunks: num({
    owner: 'streaming',
    unit: 'count',
    doc: 'Maximum render chunks held at high-detail at once.',
    default: 16,
    min: 1,
    max: 256,
    integer: true,
    tiers: { 'mobile-webgpu': 6 },
  }),
  /** Hard cap on chunks held in sim-active state (authoritative simulation running). */
  maxSimActiveChunks: num({
    owner: 'streaming',
    unit: 'count',
    doc: 'Maximum render chunks held in sim-active state at once.',
    default: 48,
    min: 1,
    max: 512,
    integer: true,
    tiers: { 'mobile-webgpu': 16 },
  }),
  /** Ticks a chunk lingers in the cooling state before it is persisted + evicted. */
  coolingTicks: num({
    owner: 'streaming',
    unit: 'ticks',
    doc: 'Ticks a chunk stays in cooling before persist+evict, to absorb camera jitter.',
    default: 120,
    min: 0,
    max: 6000,
    integer: true,
  }),
});
