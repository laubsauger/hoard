// Config domain: crafting. Owned by lane S (T24). Contextual common-sense actions are cheap + fast;
// recipes are reserved for non-obvious/specialist work. Repairs reuse the destruction material+tool
// logic. V4 — craft timing + skill scaling typed, not magic.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const craftingConfig = registerDomain('crafting', {
  baseCraftSeconds: num({
    owner: 'crafting', unit: 'seconds',
    doc: 'Baseline time to perform a contextual common-sense action at zero skill.',
    default: 3, min: 0, max: 600,
  }),
  skillTimeReductionMax: num({
    owner: 'crafting', unit: 'ratio',
    doc: 'Max fraction of craft time removed at full skill (1) — competence = reliability/speed (V31).',
    default: 0.5, min: 0, max: 0.95,
  }),
  repairStrengthPerMaterial: num({
    owner: 'crafting', unit: 'count',
    doc: 'Structural strength restored per unit of repair material (reuses destruction strength units).',
    default: 25, min: 0.1, max: 100000,
  }),
  repairToolEfficiency: num({
    owner: 'crafting', unit: 'ratio',
    doc: 'Multiplier on repair effectiveness when the correct tool is present (vs bare-hands floor).',
    default: 1, min: 0.1, max: 4,
  }),
  repairBareHandsEfficiency: num({
    owner: 'crafting', unit: 'ratio',
    doc: 'Repair effectiveness multiplier with no tool (improvised) — strictly worse than with a tool.',
    default: 0.4, min: 0, max: 1,
  }),
});
