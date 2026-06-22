// Config domain: items. Owned by lane S (T23/T24). Item DEFINITIONS are content (catalog), but the
// global validation bounds + stacking defaults that the engine enforces live here as typed tunables
// (V4 — production rejects out-of-bound content rather than inventing fallbacks).

import { num } from '../spec';
import { registerDomain } from '../registry';

export const itemsConfig = registerDomain('items', {
  maxItemWeightKg: num({
    owner: 'items', unit: 'count',
    doc: 'Upper validation bound (kg) on a single item definition weight; heavier content is rejected.',
    default: 200, min: 0.001, max: 5000,
  }),
  defaultMaxStack: num({
    owner: 'items', unit: 'count',
    doc: 'Default maximum stack count for a stackable item when its definition omits one.',
    default: 99, min: 1, max: 100000, integer: true,
  }),
});
