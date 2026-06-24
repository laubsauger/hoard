// T38 — the block scene builds real Three.js geometry + an InstancedMesh crowd from the runtime SoA, and
// drives breach visibility + the cutaway. CPU-only (no GPU), so we assert structure + sync behaviour here.

import { describe, it, expect } from 'vitest';
import { ResourceRegistry, CameraRig, resolveCameraSettings } from '../engine';
import { GameRuntime } from '../../game/runtime';
import { buildCityBlock, buildCityDistrict, buildingsOf } from '../../game/scene';
import { InMemoryPersistenceAdapter } from '../../game/persistence';
import { resolveDomain } from '../../config/registry';
import { combatConfig } from '../../config/domains/combat';
import { BlockScene } from './blockScene';

const TIER = 'desktop-high' as const;

function makeScene(hordeCount = 24) {
  const adapter = new InMemoryPersistenceAdapter();
  const runtime = new GameRuntime({ tier: TIER, adapter, scene: buildCityBlock() });
  const radius = resolveDomain(combatConfig, TIER).gateZeroSpawnRadiusMeters;
  runtime.spawnHorde(hordeCount, radius);
  const registry = new ResourceRegistry();
  const scene = new BlockScene({ runtime, tier: TIER, registry });
  return { runtime, registry, scene };
}

describe('BlockScene (T38 render integration)', () => {
  it('builds tracked geometry + a destructible section + cutaway surfaces', () => {
    const { runtime, registry, scene } = makeScene();
    const info = scene.debugInfo;
    expect(info.sectionGroups).toBe(runtime.scene.wall.sizeZ); // one hideable group per section cell
    expect(info.fadeSurfaces).toBeGreaterThanOrEqual(1); // roof (+ upper walls)
    expect(info.geometries).toBeGreaterThan(0);
    expect(registry.size).toBeGreaterThan(0); // resources tracked for disposal (V24)
  });

  it('packs the live crowd into the InstancedMesh from the SoA', () => {
    const { runtime, scene } = makeScene(24);
    expect(scene.crowd.mesh.count).toBe(runtime.aliveCount);
    expect(scene.crowd.mesh.count).toBe(24);
  });

  it('hides exactly the breached section footprint', () => {
    const { runtime, scene } = makeScene();
    const breachedCell = runtime.scene.wall.packCell(0, 0, 1);
    expect(scene.isSectionHidden(breachedCell)).toBe(false);
    runtime.breachWall();
    scene.syncFrame(0, undefined);
    expect(scene.isSectionHidden(breachedCell)).toBe(true);
  });

  it('fades the roof/upper walls for the cutaway while the player is inside (V20)', () => {
    const { scene } = makeScene();
    const camera = new CameraRig(resolveCameraSettings(TIER), 1).camera;
    expect(Math.min(...scene.debugFadeOpacity)).toBeCloseTo(1, 5); // opaque before cutaway runs
    for (let i = 0; i < 8; i++) scene.syncFrame(0.5, camera);
    expect(Math.min(...scene.debugFadeOpacity)).toBeLessThan(0.5); // roof faded to reveal the interior
  });

  // T87: blockScene now renders buildingsOf() — each building gets its own roof + per-building cutaway.
  it('renders a roof per building + fades ONLY the building the player occupies (T80 per-building cutaway)', () => {
    const adapter = new InMemoryPersistenceAdapter();
    const district = buildCityDistrict(TIER);
    const runtime = new GameRuntime({ tier: TIER, adapter, scene: district.block, sectors: district.sectors });
    runtime.spawnHorde(8, resolveDomain(combatConfig, TIER).gateZeroSpawnRadiusMeters);
    const registry = new ResourceRegistry();
    const scene = new BlockScene({ runtime, tier: TIER, registry });
    const buildingCount = buildingsOf(district.block).length;
    // each building contributes a roof + upper-wall sides AND its interior partition edges (Item D: every interior
    // partition is its own fade surface), so a templated district has strictly MORE than one surface per building.
    expect(scene.debugInfo.fadeSurfaces).toBeGreaterThan(buildingCount);

    const camera = new CameraRig(resolveCameraSettings(TIER), 1).camera;
    expect(Math.min(...scene.debugFadeOpacity)).toBeCloseTo(1, 5); // all opaque before the cutaway runs
    for (let i = 0; i < 8; i++) scene.syncFrame(0.5, camera);
    // the player's building faded (some surface revealed) while at least one NEIGHBOUR stayed fully opaque.
    expect(Math.min(...scene.debugFadeOpacity)).toBeLessThan(0.5);
    expect(Math.max(...scene.debugFadeOpacity)).toBeGreaterThan(0.95);
  });

  it('disposes the scene graph without leaking the registry', () => {
    const { registry, scene } = makeScene();
    scene.dispose();
    registry.disposeAll();
    expect(() => registry.assertNoLeaks()).not.toThrow();
  });
});
