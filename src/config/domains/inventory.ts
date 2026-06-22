// Config domain: inventory. Owned by lane S (T23). Container capacity + quick-access timing cost +
// encumbrance. V1: UI never mutates arrays; transfers run through validated commands. V4: every
// weight/capacity/timing tunable typed here, not buried in inventory logic.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const inventoryConfig = registerDomain('inventory', {
  defaultContainerCapacityKg: num({
    owner: 'inventory', unit: 'count',
    doc: 'Default weight capacity (kg) of a container when its definition omits one.',
    default: 15, min: 0, max: 5000,
  }),
  quickAccessSlotCount: num({
    owner: 'inventory', unit: 'count',
    doc: 'Number of quick-access slots (fast retrieval) on the player.',
    default: 4, min: 0, max: 32, integer: true,
  }),
  quickAccessTransferSeconds: num({
    owner: 'inventory', unit: 'seconds',
    doc: 'Time cost to pull/stow an item from a quick-access slot.',
    default: 0.4, min: 0, max: 60,
  }),
  adjacentTransferSeconds: num({
    owner: 'inventory', unit: 'seconds',
    doc: 'Time cost to transfer to/from an adjacent open container (shelf/crate/cupboard/trunk).',
    default: 1.2, min: 0, max: 120,
  }),
  deepTransferSeconds: num({
    owner: 'inventory', unit: 'seconds',
    doc: 'Time cost to dig an item out of deep storage (backpack interior) under pressure.',
    default: 2.5, min: 0, max: 120,
  }),
  encumbranceFullKg: num({
    owner: 'inventory', unit: 'count',
    doc: 'Total carried weight (kg) at which encumbrance reaches 1 (fully loaded).',
    default: 30, min: 1, max: 5000,
  }),
});
