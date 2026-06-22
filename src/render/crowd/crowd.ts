// T9 / V2 / V33 — GPU-instanced animated crowd. ONE shared mesh family + ONE InstancedMesh; NO per-zombie
// object/shader/mixer. Reads the frozen SoA views and packs them via the pure packInstances() fn.
// A per-instance variation buffer drives shader-side diversity. Resources are tracked for disposal (V24).
//
// V33 — the per-instance matrix is routed through the WebGPU node/storage-attribute path (a node
// MeshStandardNodeMaterial whose positionNode reads the instance matrix from instanced vertex buffer
// attributes). This avoids three's auto InstanceNode, which for an InstancedMesh built from CORE
// `three` uploads the WHOLE capacity-sized matrix array as a single UNIFORM buffer when the live count
// is small (<=1000). At high capacity (e.g. desktop-high 4000 -> 4000*64 = 256000 bytes) that overflows
// the 65536-byte max uniform binding, invalidating the bind group and silently dropping the crowd draw.

import {
  BoxGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedInterleavedBuffer,
  InstancedMesh,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  Fn,
  instancedDynamicBufferAttribute,
  mat4,
  normalLocal,
  positionLocal,
  transformNormal,
} from 'three/tsl';
import type { FieldViews } from '../../game/core/contracts/soa';
import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import { FLOATS_PER_MATRIX, FLOATS_PER_VARIATION, packInstances } from './packing';

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
  private readonly material: MeshStandardNodeMaterial;
  private readonly variationAttr: InstancedBufferAttribute;
  /** Instanced vertex-buffer view over instanceMatrix.array; the storage/attribute instancing path (V33). */
  private readonly matrixBuffer: InstancedInterleavedBuffer;

  constructor(settings: CrowdSettings, registry: ResourceRegistry) {
    this.settings = settings;
    // Shared mesh family placeholder (real archetype meshes land in T30). Capsule-ish box for the spike.
    this.geometry = registry.track(new BoxGeometry(0.5, 1.8, 0.4), 'geometry', 'crowd.geometry');
    this.material = registry.track(new MeshStandardNodeMaterial({ color: 0x4a5a3a }), 'material', 'crowd.material');
    this.mesh = new InstancedMesh(this.geometry, this.material, settings.capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // crowd spans large bounds; cull per-cluster later (T30)
    registry.track(this.mesh, 'buffer', 'crowd.instancedMesh');

    // V33 — route the per-instance matrix through the node/storage-attribute path. Disabling three's
    // auto InstanceNode (which keys off this flag) keeps the capacity-sized matrix array OUT of a uniform
    // binding; the draw instance count still derives from mesh.count, so this changes only the GPU path.
    (this.mesh.instanceMatrix as { isInstancedBufferAttribute: boolean }).isInstancedBufferAttribute = false;
    this.matrixBuffer = new InstancedInterleavedBuffer(this.mesh.instanceMatrix.array, FLOATS_PER_MATRIX, 1);
    this.matrixBuffer.setUsage(DynamicDrawUsage);
    // Read the column-major mat4 as four instanced vec4 vertex attributes (matches packInstances layout).
    const instanceMatrix = mat4(
      instancedDynamicBufferAttribute(this.matrixBuffer, 'vec4', FLOATS_PER_MATRIX, 0),
      instancedDynamicBufferAttribute(this.matrixBuffer, 'vec4', FLOATS_PER_MATRIX, 4),
      instancedDynamicBufferAttribute(this.matrixBuffer, 'vec4', FLOATS_PER_MATRIX, 8),
      instancedDynamicBufferAttribute(this.matrixBuffer, 'vec4', FLOATS_PER_MATRIX, 12),
    );
    this.material.positionNode = Fn(() => {
      // Rotate normals by the instance transform so lighting stays correct per instance (matches three's
      // own InstanceNode), then return the instance-space position the rest of the pipeline projects.
      normalLocal.assign(transformNormal(normalLocal, instanceMatrix));
      return instanceMatrix.mul(positionLocal).xyz;
    })();

    const variation = new Float32Array(settings.capacity * FLOATS_PER_VARIATION);
    this.variationAttr = new InstancedBufferAttribute(variation, FLOATS_PER_VARIATION);
    this.variationAttr.setUsage(DynamicDrawUsage);
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
    this.matrixBuffer.needsUpdate = true; // re-upload the instanced matrix attribute (V33 storage path)
    this.variationAttr.needsUpdate = true;
    return liveCount;
  }
}
