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

  // ---- T87 residential house VARIATION (V26 — deterministic per-house seed drives a unique house) ----
  // Every range/probability below is a typed tunable; authorHouseStyle() consumes the resolved values and a
  // per-house seed to emit one concrete HouseStyle. No two houses are identical; the same seed always
  // replays the same house. Discrete palettes (wall/roof/trim hex) are authored content arrays in houseStyle.

  /** Probability a house is two-storey rather than single-storey. */
  houseTwoStoreyChance: num({ owner: 'world', unit: 'ratio', doc: 'P(house is two-storey) — drives wall + window-band height (V26).', default: 0.38, min: 0, max: 1 }),
  /** Probability a house has a flat roof (checked first). */
  houseFlatRoofChance: num({ owner: 'world', unit: 'ratio', doc: 'P(flat roof). Checked before hip; remainder after hip is gable (V26).', default: 0.14, min: 0, max: 1 }),
  /** Probability a house has a hip roof (checked after flat). Remainder is a gable roof. */
  houseHipRoofChance: num({ owner: 'world', unit: 'ratio', doc: 'P(hip roof) given not flat; remainder is gable (V26).', default: 0.42, min: 0, max: 1 }),
  /** Minimum ridge rise (m) above the wall top for a pitched roof. */
  houseRoofPitchMinMeters: num({ owner: 'world', unit: 'meters', doc: 'Min ridge rise above wall top for a pitched roof.', default: 1.1, min: 0.1, max: 8 }),
  /** Maximum ridge rise (m) above the wall top for a pitched roof. */
  houseRoofPitchMaxMeters: num({ owner: 'world', unit: 'meters', doc: 'Max ridge rise above wall top for a pitched roof.', default: 2.6, min: 0.2, max: 12 }),
  /** Roof eave overhang (m) past the wall on each side. */
  houseRoofOverhangMeters: num({ owner: 'world', unit: 'meters', doc: 'Roof eave overhang past the wall on each side.', default: 0.5, min: 0, max: 3 }),
  /** Probability a house has a covered front porch at its door. */
  housePorchChance: num({ owner: 'world', unit: 'ratio', doc: 'P(house has a covered front porch at the door).', default: 0.55, min: 0, max: 1 }),
  /** Depth (m) a porch roof extends out from the front wall. */
  housePorchDepthMeters: num({ owner: 'world', unit: 'meters', doc: 'Depth a porch roof extends out from the front wall.', default: 2.0, min: 0.5, max: 5 }),
  /** Probability a house has a chimney. */
  houseChimneyChance: num({ owner: 'world', unit: 'ratio', doc: 'P(house has a chimney on the roof).', default: 0.5, min: 0, max: 1 }),

  // ---- T87 states of DISARRAY (post-apocalyptic decay; deterministic per house) ----
  /** Lower bound of the per-house damage level (0..1). */
  houseDamageMin: num({ owner: 'world', unit: 'ratio', doc: 'Lower bound of per-house damage 0..1 (lightly weathered).', default: 0.06, min: 0, max: 1 }),
  /** Upper bound of the per-house damage level (0..1). */
  houseDamageMax: num({ owner: 'world', unit: 'ratio', doc: 'Upper bound of per-house damage 0..1 (heavily ruined).', default: 0.96, min: 0, max: 1 }),
  /** How far the wall tint blends toward weathered grey at damage = 1. */
  houseWeatherMaxBlend: num({ owner: 'world', unit: 'ratio', doc: 'Max blend of wall tint toward weathered grey at full damage.', default: 0.6, min: 0, max: 1 }),
  /** Of broken windows, the fraction that are BOARDED (rest are smashed-open voids). */
  houseWindowBoardedFraction: num({ owner: 'world', unit: 'ratio', doc: 'Fraction of damaged windows that are boarded vs smashed-open.', default: 0.5, min: 0, max: 1 }),
  houseWindowStride: num({ owner: 'world', unit: 'count', doc: 'Place a window every Nth eligible facade cell — higher = sparser/believable (every-other reads as a greenhouse band).', default: 3, min: 1, max: 12, integer: true }),
  /** Damage at/above which the roof starts losing shingle patches (holes). */
  houseRoofHoleDamageThreshold: num({ owner: 'world', unit: 'ratio', doc: 'Damage at/above which roof holes (missing shingle patches) appear.', default: 0.38, min: 0, max: 1 }),
  /** Max number of roof holes on the most-ruined house. */
  houseRoofHoleMaxCount: num({ owner: 'world', unit: 'count', doc: 'Max roof holes / exposed-rafter patches on a fully ruined roof.', default: 3, min: 0, max: 12, integer: true }),
  /** Damage at/above which a house shows a collapsed/sagging section + heavy rubble. */
  houseCollapseDamageThreshold: num({ owner: 'world', unit: 'ratio', doc: 'Damage at/above which a roof sags + a wall section collapses into rubble.', default: 0.76, min: 0, max: 1 }),
  /** Probability a house has ivy/overgrowth creeping its walls. */
  houseIvyChance: num({ owner: 'world', unit: 'ratio', doc: 'P(ivy/overgrowth creeps up the walls).', default: 0.6, min: 0, max: 1 }),
  /** Max fraction of wall height ivy reaches on the most-overgrown house. */
  houseIvyMaxCoverage: num({ owner: 'world', unit: 'ratio', doc: 'Max fraction of wall height ivy climbs on the most overgrown house.', default: 0.9, min: 0, max: 1 }),
  /** Max debris/rubble clumps strewn at the base of a fully ruined house (scaled by damage). */
  houseDebrisMaxCount: num({ owner: 'world', unit: 'count', doc: 'Max debris/rubble clumps at the base of a fully ruined house.', default: 7, min: 0, max: 40, integer: true }),

  // ---- T87 fence + yard disarray (deterministic per fence span / tree from its cell) ----
  /** Probability an individual fence picket span is MISSING (a gap in the run). */
  fenceMissingChance: num({ owner: 'world', unit: 'ratio', doc: 'P(a fence span is missing → a gap in the run).', default: 0.16, min: 0, max: 1 }),
  /** Probability a present fence span is BROKEN (short/snapped, lower height). */
  fenceBrokenChance: num({ owner: 'world', unit: 'ratio', doc: 'P(a present fence span is broken/snapped to partial height).', default: 0.22, min: 0, max: 1 }),
  /** Max lean (radians) a leaning fence span tilts from vertical. */
  fenceLeanMaxRadians: num({ owner: 'world', unit: 'radians', doc: 'Max tilt from vertical for a leaning fence span.', default: 0.32, min: 0, max: 1.2 }),
  /** Probability a yard tree is dead/bare (leaning, branches, no foliage) rather than live. */
  treeDeadChance: num({ owner: 'world', unit: 'ratio', doc: 'P(a yard tree is a dead bare tree rather than a live leafy one).', default: 0.3, min: 0, max: 1 }),
});
