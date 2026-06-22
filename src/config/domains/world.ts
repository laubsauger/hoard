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
});
