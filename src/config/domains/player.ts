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
  /** Player walk speed (m/s) applied to WASD movement intent (T38 vertical slice). */
  moveSpeedMetersPerSecond: num({
    owner: 'player',
    unit: 'metersPerSecond',
    doc: 'Player ground movement speed applied to normalized WASD intent each frame. 4.5 read a tad too fast for a normal walk; 3.8 is a brisk walk (sprint/crouch multipliers scale off it).',
    default: 3.8,
    min: 0.1,
    max: 20,
  }),
  /** Sprint speed multiplier applied to the walk speed while the player is sprinting (escape lever). */
  playerSprintSpeedMultiplier: num({
    owner: 'player',
    unit: 'ratio',
    doc: 'Multiplier on the walk speed while sprinting (outrun the horde — gated by stamina, T22).',
    default: 1.6,
    min: 1,
    max: 4,
  }),
  /** Crouch speed multiplier applied to the walk speed while crouching (the sneak stance) — slow + quiet (V86). */
  playerCrouchSpeedMultiplier: num({
    owner: 'player',
    unit: 'ratio',
    doc: 'Multiplier on the walk speed while crouching (the sneak stance): a slow, quiet, low-profile crawl (V86).',
    default: 0.5,
    min: 0.1,
    max: 1,
  }),
  /** Rendered player body capsule height (m). */
  bodyHeightMeters: num({
    owner: 'player',
    unit: 'meters',
    doc: 'Rendered height of the player avatar capsule.',
    default: 1.8,
    min: 0.5,
    max: 3,
  }),
  /** Player body capsule radius (m) — drives BOTH the rendered avatar capsule AND the radius-aware movement
   *  collision (movePlayer / door-trap guard). */
  bodyRadiusMeters: num({
    owner: 'player',
    unit: 'meters',
    doc: 'Radius of the player avatar capsule + the radius-aware movement collision. LOWERED 0.35→0.28 (0.56 m body width): after the nav grid refined 2 m→1 m a single-cell doorway is only ~1 m wide, so a 0.7 m-wide body left ~0.3 m slack and snagged on the frame on any off-centre approach (the "doors too huge / always getting stuck" report). 0.28 clears a 1 m doorway comfortably while staying a believable human footprint.',
    default: 0.28,
    min: 0.1,
    max: 1,
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
