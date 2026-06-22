// Config domain: combat. Owned by lane S (forward-pulled subset for GATE-0 / T41; full T16 later).
// V4 — resolution tunables + the GATE-0 horde-vs-player proof sizing are typed, never literals.
// V16 — damage resolves vs a named anatomical region + armor + penetration; head fatal by default.

import { bool, num } from '../spec';
import { registerDomain } from '../registry';

export const combatConfig = registerDomain('combat', {
  /** Default zombie health for the test-block population (T16/T17 archetypes refine this later). */
  zombieBaseHealth: num({
    owner: 'combat',
    unit: 'count',
    doc: 'Default zombie health for the GATE-0 test population.',
    default: 100,
    min: 1,
    max: 10_000,
  }),
  /** Flat damage subtracted before health loss (reduced by firearm penetration). */
  zombieBaseArmor: num({
    owner: 'combat',
    unit: 'count',
    doc: 'Default flat zombie armor (damage reduction) before penetration is applied.',
    default: 10,
    min: 0,
    max: 1000,
  }),
  /** Effective damage at/above which a severable region (limb/head) is flagged severed (V17). */
  severDamageThreshold: num({
    owner: 'combat',
    unit: 'count',
    doc: 'Effective damage on a severable region at/above which it is flagged severed.',
    default: 25,
    min: 1,
    max: 10_000,
  }),
  /** Head/neck destruction is fatal unless an archetype overrides (V17). */
  headFatalEnabled: bool({
    owner: 'combat',
    doc: 'Whether a resolved head/neck hit is fatal by default (head-kill rule, V17).',
    default: true,
  }),
  /** Ticks after taking damage during which a zombie is force-promoted to hero fidelity (V13). */
  recentDamageWindowTicks: num({
    owner: 'combat',
    unit: 'ticks',
    doc: 'Ticks a damaged zombie counts as recently-damaged for mandatory tier promotion.',
    default: 30,
    min: 0,
    max: 600,
    integer: true,
  }),
  /** Horde locomotion speed toward the shared flow-field target (world meters per second). */
  hordeMoveSpeed: num({
    owner: 'combat',
    unit: 'meters',
    doc: 'Horde locomotion speed in world meters per simulation second (steering integrate step).',
    default: 1.4,
    min: 0.1,
    max: 12,
  }),
  /** Weight of the shared flow direction vs local separation when steering (1 = pure flow). */
  steerFlowWeight: num({
    owner: 'combat',
    unit: 'ratio',
    doc: 'Blend of shared flow-field direction vs neighbour separation in local steering (V15/V19).',
    default: 0.85,
    min: 0,
    max: 1,
  }),
  /** Separation radius pushing crowd members apart during steering (V19). */
  steerSeparationMeters: num({
    owner: 'combat',
    unit: 'meters',
    doc: 'Neighbour separation radius used by local steering to spread the crowd (V19).',
    default: 0.8,
    min: 0.1,
    max: 8,
  }),
  /** Available perf budget fed to the tier policy each frame (1 = full; lowers suppress promotions). */
  perfBudget: num({
    owner: 'combat',
    unit: 'ratio',
    doc: 'Available perf budget supplied to the tier manager (V13/V22). 1 = unconstrained.',
    default: 1,
    min: 0,
    max: 1,
  }),
  /** GATE-0 proof: number of zombies spawned in the test block (must be >= 500 to satisfy T41). */
  gateZeroZombieCount: num({
    owner: 'combat',
    unit: 'count',
    doc: 'Zombie population spawned for the GATE-0 vertical-proof test block (T41 requires >= 500).',
    default: 500,
    min: 1,
    max: 200_000,
    integer: true,
  }),
  /** GATE-0 proof: half-extent of the square spawn area for the horde in room A (meters). */
  gateZeroSpawnRadiusMeters: num({
    owner: 'combat',
    unit: 'meters',
    doc: 'Half-extent of the square area over which the GATE-0 horde is scattered at spawn.',
    default: 14,
    min: 1,
    max: 200,
  }),
});
