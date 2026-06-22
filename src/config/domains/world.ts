// Config domain: world. Owned by lane S. Spatial hierarchy scales (§I) + district/sector/chunk sizes.
// V4 — every spatial scale is a typed config value with unit+owner+default+range, not a hardcoded truth.
// Default scales from §I: District ~512m, Sector ~128m, render chunk ~32m.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const worldConfig = registerDomain('world', {
  /** District edge length (square). §I DEFAULT ~512 m. Save partition + long-range population unit. */
  districtSize: num({
    owner: 'world',
    unit: 'meters',
    doc: 'Edge length of a district (square). Save partition + long-range population boundary.',
    default: 512,
    min: 128,
    max: 2048,
  }),
  /** Streaming sector edge length. §I DEFAULT ~128 m. Asset manifest + activation priority unit. */
  sectorSize: num({
    owner: 'world',
    unit: 'meters',
    doc: 'Edge length of a streaming sector (square). Asset manifest + abstract-sim boundary.',
    default: 128,
    min: 32,
    max: 512,
  }),
  /** Render chunk edge length. §I DEFAULT ~32 m. Static batch + scene-attach unit. */
  chunkSize: num({
    owner: 'world',
    unit: 'meters',
    doc: 'Edge length of a render chunk (square). Static batches + visibility + scene attach.',
    default: 32,
    min: 8,
    max: 128,
  }),
  /** Authored building wall height (m) for the M1 block scene (T38). Drives wall + cutaway geometry. */
  buildingWallHeightMeters: num({
    owner: 'world',
    unit: 'meters',
    doc: 'Height of authored building/interior walls in the city-block scene.',
    default: 3,
    min: 0.5,
    max: 20,
  }),
  /** Authored floor slab thickness (m) for the M1 block scene. */
  floorThicknessMeters: num({
    owner: 'world',
    unit: 'meters',
    doc: 'Thickness of authored floor/street slabs in the city-block scene.',
    default: 0.2,
    min: 0.05,
    max: 2,
  }),
  /** Authored roof slab thickness (m) for the M1 block scene (the cutaway-faded layer). */
  roofThicknessMeters: num({
    owner: 'world',
    unit: 'meters',
    doc: 'Thickness of authored building roof slabs (the cutaway-faded layer) in the block scene.',
    default: 0.3,
    min: 0.05,
    max: 2,
  }),

  // ---- M2 district scale (T40). A representative district is a grid of streaming sectors; offscreen
  // sectors hold an ABSTRACT population (V13) that promotes to live sim when the player nears them. ----

  /** Sectors per district along X. The district grid is districtSectorsX × districtSectorsZ sectors. */
  districtSectorsX: num({
    owner: 'world',
    unit: 'count',
    doc: 'Number of streaming sectors along X in the representative M2 district.',
    default: 3,
    min: 1,
    max: 16,
    integer: true,
  }),
  /** Sectors per district along Z. */
  districtSectorsZ: num({
    owner: 'world',
    unit: 'count',
    doc: 'Number of streaming sectors along Z in the representative M2 district.',
    default: 2,
    min: 1,
    max: 16,
    integer: true,
  }),
  /** Abstract horde population seeded per offscreen sector (V13 — abstract tier promotes near player). */
  abstractPopulationPerSector: num({
    owner: 'world',
    unit: 'count',
    doc: 'Abstract horde population seeded per sector before it is streamed in (V13).',
    default: 40,
    min: 0,
    max: 100_000,
    integer: true,
    tiers: { 'mobile-webgpu': 16 },
  }),
  /** Distance from a sector centre at/under which the sector activates + promotes abstract pop (V13). */
  sectorActivateRadiusMeters: num({
    owner: 'world',
    unit: 'meters',
    doc: 'Player distance to a sector centre at/under which the sector streams in + promotes abstract pop.',
    default: 60,
    min: 1,
    max: 1024,
  }),
  /** Distance from a sector centre beyond which an active sector cools down toward eviction. Must be
   *  larger than the activate radius so streaming does not thrash at the boundary. */
  sectorEvictRadiusMeters: num({
    owner: 'world',
    unit: 'meters',
    doc: 'Player distance beyond which an active sector cools toward persist+evict (hysteresis vs activate).',
    default: 110,
    min: 1,
    max: 2048,
  }),
  /** Hard cap on how many abstract members a single sector promotes to live sim at once (perf budget). */
  promotedPerSectorCap: num({
    owner: 'world',
    unit: 'count',
    doc: 'Max abstract members a sector promotes to live simulation per activation (perf budget, V13/V22).',
    default: 24,
    min: 0,
    max: 5000,
    integer: true,
    tiers: { 'mobile-webgpu': 8 },
  }),
});
