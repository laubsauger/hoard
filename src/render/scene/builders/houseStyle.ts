// Deterministic, replay-stable per-building house style (V26): seeded off each building's STABLE footprint so
// the same lot always authors the same house, and the renderer + the sim WindowSystem derive the SAME
// seed/damage (one source of truth). The §G feature building is kept lightly weathered + un-collapsed so its
// interior stays readable. Shared by the house + openings builders. Extracted from BlockScene
// (docs/REFACTOR-godfiles.md).

import {
  houseStyleForBuilding,
  featureBuildingIndexOf,
  type BuildingFootprint,
  type HouseStyle,
  type HouseVariationParams,
  type TestBlock,
} from '../../../game/scene';

export class HouseStyleResolver {
  /** Index of the building holding the destructible §G section cells (kept readable / less decay), or -1. */
  readonly featureBuildingIndex: number;

  constructor(
    town: TestBlock,
    /** Tier-resolved house-variation params (decay/roof-hole thresholds, etc) — also read by the house builder. */
    readonly variation: HouseVariationParams,
  ) {
    this.featureBuildingIndex = featureBuildingIndexOf(town);
  }

  styleFor(bld: BuildingFootprint, bi: number): HouseStyle {
    return houseStyleForBuilding(bld.bounds, bld.storeys, bi, this.variation, this.featureBuildingIndex);
  }
}
