// Config domain: navigation. Owned by lane S. Tiled navmesh + flow-field tunables (T11).
// V5 — local edits rebuild only affected nav tiles. V15 — groups share flow fields, not per-agent A*.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const navigationConfig = registerDomain('navigation', {
  /** Navigation tile edge length. §I DEFAULT ~16 m. Local path data + dirty-region rebuild unit. */
  navTileSize: num({
    owner: 'navigation',
    unit: 'meters',
    doc: 'Edge length of a navigation tile (square). Dirty-region rebuild granularity.',
    default: 16,
    min: 4,
    max: 64,
  }),
  /** Cost-grid cell edge length (sub-tile resolution for flow/cost fields). */
  navCellSize: num({
    owner: 'navigation',
    unit: 'meters',
    doc: 'Edge length of a nav cost-grid cell (square). Flow-field + Dijkstra resolution.',
    default: 2,
    min: 0.5,
    max: 8,
  }),
  /** Cost charged to enter a normal walkable cell (uniform base cost). */
  baseTraversalCost: num({
    owner: 'navigation',
    unit: 'count',
    doc: 'Cost to enter a normal walkable cell (Dijkstra unit cost).',
    default: 1,
    min: 1,
    max: 1000,
    integer: true,
  }),
  /** Sentinel cost marking a blocked / unreachable cell. */
  blockedCost: num({
    owner: 'navigation',
    unit: 'count',
    doc: 'Cost value marking a blocked cell (treated as impassable).',
    default: 65535,
    min: 1000,
    max: 1_000_000,
    integer: true,
  }),
  /** Max cached flow fields (keyed by target+profile+navRevision) before LRU eviction. */
  flowFieldCacheSize: num({
    owner: 'navigation',
    unit: 'count',
    doc: 'Maximum cached flow fields before least-recently-used eviction.',
    default: 32,
    min: 1,
    max: 512,
    integer: true,
    tiers: { 'mobile-webgpu': 8 },
  }),
});
