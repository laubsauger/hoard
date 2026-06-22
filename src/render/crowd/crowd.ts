// T9 / V2 — GPU-instanced animated crowd. ONE shared mesh family + ONE InstancedMesh; NO per-zombie
// object/shader/mixer. Reads the frozen SoA views and packs them via the pure packInstances() fn.
// A per-instance variation buffer drives shader-side diversity. Resources are tracked for disposal (V24).

import {
  BoxGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
} from 'three';
import type { FieldViews } from '../../game/core/contracts/soa';
import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import { FLOATS_PER_VARIATION, packInstances } from './packing';

export interface CrowdSettings {
  readonly capacity: number;
  readonly variationCount: number;
  readonly scaleMin: number;
  readonly scaleMax: number;
}

export function resolveCrowdSettings(tier: QualityTier): CrowdSettings {
  return {
    capacity: resolve(renderingConfig.crowdInstanceCapacity, tier),
    variationCount: resolve(renderingConfig.crowdVariationCount, tier),
    scaleMin: resolve(renderingConfig.crowdInstanceScaleMin, tier),
    scaleMax: resolve(renderingConfig.crowdInstanceScaleMax, tier),
  };
}

/**
 * Owns the shared crowd InstancedMesh. Construction is CPU-only (no GPU) so it can be instantiated in
 * tests, but the heavy correctness logic lives in the pure packInstances() fn which we unit-test directly.
 */
export class Crowd {
  readonly mesh: InstancedMesh;
  readonly settings: CrowdSettings;
  private readonly geometry: BoxGeometry;
  private readonly material: MeshStandardMaterial;
  private readonly variationAttr: InstancedBufferAttribute;

  constructor(settings: CrowdSettings, registry: ResourceRegistry) {
    this.settings = settings;
    // Shared mesh family placeholder (real archetype meshes land in T30). Capsule-ish box for the spike.
    this.geometry = registry.track(new BoxGeometry(0.5, 1.8, 0.4), 'geometry', 'crowd.geometry');
    this.material = registry.track(new MeshStandardMaterial({ color: 0x4a5a3a }), 'material', 'crowd.material');
    this.mesh = new InstancedMesh(this.geometry, this.material, settings.capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // crowd spans large bounds; cull per-cluster later (T30)
    registry.track(this.mesh, 'buffer', 'crowd.instancedMesh');

    const variation = new Float32Array(settings.capacity * FLOATS_PER_VARIATION);
    this.variationAttr = new InstancedBufferAttribute(variation, FLOATS_PER_VARIATION);
    this.variationAttr.setUsage(35048 /* DynamicDrawUsage */);
    this.geometry.setAttribute('aVariation', this.variationAttr);
  }

  /** Pack `count` SoA slots into the instance buffer and flag the GPU buffers dirty. */
  update(views: FieldViews, count: number): number {
    const matrices = this.mesh.instanceMatrix.array as Float32Array;
    const variation = this.variationAttr.array as Float32Array;
    const { liveCount } = packInstances(views, matrices, variation, {
      count,
      capacity: this.settings.capacity,
      variationCount: this.settings.variationCount,
      scaleMin: this.settings.scaleMin,
      scaleMax: this.settings.scaleMax,
    });
    this.mesh.count = liveCount;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.variationAttr.needsUpdate = true;
    return liveCount;
  }
}
