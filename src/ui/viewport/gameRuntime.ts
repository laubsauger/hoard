// Phase 3 (GameViewport decomposition): authoritative runtime construction for the world viewport.
// Builds a representative city district (multiple streaming sectors with abstract populations, V13)
// and the GameRuntime that owns it. Shared by both the initial mount and the reload/load path — the
// reload rebuilds a fresh district + runtime, then calls loadFrom() on it (the viewport reassigns its
// `runtime` binding to the fresh instance, so live closures re-target automatically).

import { GameRuntime } from '../../game/runtime';
import { buildCityDistrict } from '../../game/scene';
import type { PersistenceAdapter } from '../../game/persistence';
import type { QualityTier } from '../../config/types';

/** Build a representative city district + its authoritative GameRuntime (M2, V13). No horde yet. */
export function createGameRuntime(tier: QualityTier, adapter: PersistenceAdapter): GameRuntime {
  const district = buildCityDistrict(tier);
  return new GameRuntime({ tier, adapter, scene: district.block, sectors: district.sectors });
}
