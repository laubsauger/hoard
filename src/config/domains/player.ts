// Config domain: player. Owned by lane U/INT (forward-pulled subset for GATE-0 / T41).
// V4 — player avatar initial condition + fire geometry are typed config, not literals.
// Survival fields here are the initial PlayerViewSnapshot values; T22 owns their runtime evolution.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const playerConfig = registerDomain('player', {
  /** Player maximum health. */
  maxHealth: num({
    owner: 'player',
    unit: 'count',
    doc: 'Player maximum health.',
    default: 100,
    min: 1,
    max: 10_000,
  }),
  /** Player health at scenario start. */
  startHealth: num({
    owner: 'player',
    unit: 'count',
    doc: 'Player health at scenario start.',
    default: 100,
    min: 1,
    max: 10_000,
  }),
  /** Height of the firearm muzzle / aim origin above the floor (y), for the hit ray. */
  aimOriginHeight: num({
    owner: 'player',
    unit: 'meters',
    doc: 'Height above the floor of the firearm aim origin used to cast the hit ray.',
    default: 1.6,
    min: 0.1,
    max: 3,
  }),
  /** Initial hunger pressure (0 = sated). */
  initialHunger: num({
    owner: 'player',
    unit: 'ratio',
    doc: 'Initial hunger pressure for the player-view snapshot (0 = sated).',
    default: 0,
    min: 0,
    max: 1,
  }),
  /** Initial thirst pressure (0 = sated). */
  initialThirst: num({
    owner: 'player',
    unit: 'ratio',
    doc: 'Initial thirst pressure for the player-view snapshot (0 = sated).',
    default: 0,
    min: 0,
    max: 1,
  }),
  /** Initial fatigue pressure (0 = rested). */
  initialFatigue: num({
    owner: 'player',
    unit: 'ratio',
    doc: 'Initial fatigue pressure for the player-view snapshot (0 = rested).',
    default: 0,
    min: 0,
    max: 1,
  }),
  /** Initial stress pressure (0 = calm). */
  initialStress: num({
    owner: 'player',
    unit: 'ratio',
    doc: 'Initial stress pressure for the player-view snapshot (0 = calm).',
    default: 0,
    min: 0,
    max: 1,
  }),
});
