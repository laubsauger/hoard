// Config domain: game. Owned by lane F (core). Top-level game identity + global toggles.

import { bool, enumOf, num } from '../spec';
import { registerDomain } from '../registry';

export const gameConfig = registerDomain('game', {
  /** Working-title identity tag (not localized). */
  title: enumOf({
    owner: 'game',
    doc: 'Build title identity.',
    values: ['Ho(a)rdish by Nature'] as const,
    default: 'Ho(a)rdish by Nature',
  }),
  /** Single-player is the recommended default for the initial complete game (§C). */
  singlePlayer: bool({
    owner: 'game',
    doc: 'Initial complete game is single-player only.',
    default: true,
  }),
  /** Event-record pool size for the bounded high-frequency gameplay event queue (V/§I). */
  eventPoolSize: num({
    owner: 'game',
    unit: 'count',
    doc: 'Capacity of the pooled per-tick gameplay event queue.',
    default: 4096,
    min: 256,
    max: 65536,
    integer: true,
    tiers: { 'mobile-webgpu': 2048 },
  }),
});
