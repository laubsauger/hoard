// Config domain: fire. Owned by lane S (T26). Ignition/burn/spread + emitted light/smoke/sound/heat.
// V18 — fire is compact persistent state (burning cells with fuel), NOT thousands of particles. Rates
// are per IN-GAME SECOND; the FireSim multiplies by elapsed seconds. V4 — no burn-rate magic numbers.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const fireConfig = registerDomain('fire', {
  ignitionFuel: num({
    owner: 'fire', unit: 'count',
    doc: 'Default fuel units a freshly ignited flammable cell starts with.',
    default: 100, min: 1, max: 100000,
  }),
  burnRatePerSec: num({
    owner: 'fire', unit: 'count',
    doc: 'Fuel units consumed per second by a burning cell at full intensity.',
    default: 5, min: 0.01, max: 10000,
  }),
  structuralDamagePerSec: num({
    owner: 'fire', unit: 'count',
    doc: 'Structural strength removed per second from a burning cell (damage-over-time).',
    default: 8, min: 0, max: 100000,
  }),
  spreadChancePerSec: num({
    owner: 'fire', unit: 'ratio',
    doc: 'Per-second probability a burning cell ignites an adjacent flammable cell within spread radius.',
    default: 0.25, min: 0, max: 1,
  }),
  spreadRadiusCells: num({
    owner: 'fire', unit: 'cells',
    doc: 'Radius (cells) over which fire can jump to flammable neighbours.',
    default: 1, min: 0, max: 8, integer: true,
  }),
  lightIntensity: num({
    owner: 'fire', unit: 'ratio',
    doc: 'Normalized light emission (0..1) of a burning cell at full intensity (drives dynamic light).',
    default: 0.8, min: 0, max: 1,
  }),
  smokeIntensity: num({
    owner: 'fire', unit: 'ratio',
    doc: 'Normalized smoke emission (0..1) of a burning cell (reduces visibility / drives evacuation).',
    default: 0.6, min: 0, max: 1,
  }),
  stimulusIntensity: num({
    owner: 'fire', unit: 'ratio',
    doc: 'Intensity (0..1) of the fire Stimulus emitted per burning cluster (perception input, V14).',
    default: 0.7, min: 0, max: 1,
  }),
  stimulusRadiusMeters: num({
    owner: 'fire', unit: 'meters',
    doc: 'Radius (m) of the emitted fire Stimulus — fire is seen/smelled from a distance.',
    default: 12, min: 1, max: 200,
  }),
  stimulusDecayPerTick: num({
    owner: 'fire', unit: 'ratio',
    doc: 'Per-tick decay of the fire Stimulus (re-emitted while burning; lingers briefly after).',
    default: 0.05, min: 0.0001, max: 1,
  }),
  burnoutDamagePerSec: num({
    owner: 'fire', unit: 'count',
    doc: 'Residual structural damage per second from embers after fuel is exhausted (intensity decay).',
    default: 2, min: 0, max: 100000,
  }),

  // ---- T145: a zombie can CATCH FIRE (burn status) — DoT + spread to neighbours (torch melee / molotov / fire) ----
  zombieBurnDamagePerSec: num({
    owner: 'fire', unit: 'count',
    doc: 'Health removed per second from a BURNING zombie (fire damage-over-time). At ~baseline health this kills over a few seconds.',
    default: 16, min: 0, max: 100000,
  }),
  zombieBurnDurationSeconds: num({
    owner: 'fire', unit: 'seconds',
    doc: 'How long a zombie stays alight after being ignited (re-stoked each time it is re-ignited).',
    default: 7, min: 0.1, max: 120,
  }),
  zombieBurnSpreadChancePerSec: num({
    owner: 'fire', unit: 'ratio',
    doc: 'Per-second probability a burning zombie ignites another zombie within the spread radius (a fire chain through a packed horde).',
    default: 0.5, min: 0, max: 1,
  }),
  zombieBurnSpreadRadiusMeters: num({
    owner: 'fire', unit: 'meters',
    doc: 'Distance (m) within which a burning zombie can set a neighbour alight.',
    default: 1.6, min: 0, max: 20,
  }),
});
