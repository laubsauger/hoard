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

  // ---- M2 medium-term objective (T40). Hybrid sandbox + direction: the player MAY ignore these until
  // they choose to call evacuation, which arms the only hard timer (the decisive climax). ----

  /** Radio parts the player must scavenge before the radio can be repaired. */
  objectivePartsRequired: num({
    owner: 'game',
    unit: 'count',
    doc: 'Number of radio parts to scavenge before repair can begin (medium-term objective).',
    default: 3,
    min: 1,
    max: 32,
    integer: true,
  }),
  /** Ticks of repair work required to fix the radio once all parts are collected. */
  radioRepairTicks: num({
    owner: 'game',
    unit: 'ticks',
    doc: 'Ticks of accumulated repair work to fix the radio once all parts are collected.',
    default: 300,
    min: 1,
    max: 1_000_000,
    integer: true,
  }),
  /** Countdown (ticks) once evacuation is called: reach the exit before it elapses or the objective fails. */
  evacuationCountdownTicks: num({
    owner: 'game',
    unit: 'ticks',
    doc: 'Countdown ticks after evacuation is called to reach the exit (the decisive-climax timer).',
    default: 1200,
    min: 1,
    max: 1_000_000,
    integer: true,
  }),
});
