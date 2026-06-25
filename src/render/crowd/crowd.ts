// T9 / T140 / V2 / V33 — GPU-instanced animated crowd. The crowd is drawn by exactly TWO lanes sharing ONE
// distance partition: the RIGGED GPU-skinned lane (RiggedCrowd — baked bone-matrix texture, instanced skinning)
// for the near/mid band, and a baked billboard IMPOSTOR lane (CrowdImpostors — azimuthal sprite atlas) for the
// far band. There is NO BoxGeometry crowd and NO count budget anywhere: every in-view, alive zombie within the
// rigged distance is a full rigged figure; beyond it, a recognizable zombie billboard. The count is bounded only
// by the sim's zombie cap (crowdInstanceCapacity) + frustum / vision-cone culling.
//
// History (deleted): the original spike drew the whole "horde" as one BoxGeometry InstancedMesh assembled by a
// TSL compute shader, with a CPU per-part block-limbed figure path (CrowdLimbs) for a budgeted near pool. Both
// the box path and the limb path + their `crowdLimbedBudget` count split are GONE — they produced the visible
// boxes at horde scale. The rigged lane (which had inherited the limb budget) now has no budget, and the far
// band degrades to the impostor lane instead of boxes.

import { Group } from 'three';
import type { ComputeNode, StorageBufferNode } from 'three/webgpu';
import { Fn, float, instanceIndex, instancedArray } from 'three/tsl';
import type { FieldViews } from '../../game/core/contracts/soa';
import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import { computeDistanceBand, variationScale, variationSeed } from './packing';
import type { VisionCull } from './visionCull';
import { RiggedCrowd, RIGGED_HEIGHT_METERS } from './rigged';
import { CrowdImpostors } from './impostor';

export interface CrowdSettings {
  readonly capacity: number;
  readonly variationCount: number;
  readonly scaleMin: number;
  readonly scaleMax: number;
  readonly brightnessSpread: number;
  /** Max distance (m) a zombie renders as a full RIGGED figure; beyond it, the billboard impostor lane (T140). */
  readonly riggedMaxDistance: number;
  /** Azimuthal yaw views baked into each archetype's impostor sprite atlas (T140). */
  readonly impostorAngleCount: number;
  /** Per-yaw tile HEIGHT (px) of the baked impostor atlas (T140). */
  readonly impostorTileHeight: number;
  /** Triangle cap when CPU-rasterizing the impostor silhouette atlas at bake (T140). */
  readonly impostorMaxTriangles: number;
}

export function resolveCrowdSettings(tier: QualityTier): CrowdSettings {
  return {
    capacity: resolve(renderingConfig.crowdInstanceCapacity, tier),
    variationCount: resolve(renderingConfig.crowdVariationCount, tier),
    scaleMin: resolve(renderingConfig.crowdInstanceScaleMin, tier),
    scaleMax: resolve(renderingConfig.crowdInstanceScaleMax, tier),
    brightnessSpread: resolve(renderingConfig.crowdVariationBrightnessSpread, tier),
    riggedMaxDistance: resolve(renderingConfig.crowdRiggedMaxDistanceMeters, tier),
    impostorAngleCount: resolve(renderingConfig.crowdImpostorAngleCount, tier),
    impostorTileHeight: resolve(renderingConfig.crowdImpostorTileHeightPx, tier),
    impostorMaxTriangles: resolve(renderingConfig.crowdImpostorMaxTriangles, tier),
  };
}

/**
 * Owns the crowd scene-graph root + the two render lanes (rigged near, impostor far). Construction is CPU-only:
 * the lanes build their node graphs without a GPU device; only `rigged.attach` (GLB bake → bone texture + impostor
 * atlas) and frame submission touch real GPU resources. The pure distance partition lives in `computeDistanceBand`
 * and is unit-tested.
 */
export class Crowd {
  /** Crowd scene-graph ROOT (the object blockScene adds to the scene). The rigged + impostor InstancedMeshes are
   *  parented under it, so `scene.add(crowd.mesh)` carries the whole crowd and `crowd.update()` drives it. Was the
   *  box InstancedMesh; now a plain Group (no BoxGeometry crowd anywhere). */
  readonly mesh: Group;
  readonly settings: CrowdSettings;
  /**
   * Compat shim (T140): the render loop still calls `host.compute(crowd.computeNode)` each frame (it drove the old
   * box transform-assembly compute). The rigged + impostor lanes need no compute pass, so this is a 1-thread no-op
   * kept ONLY so the out-of-scope render-loop call stays valid; it can be dropped once the loop stops calling it.
   */
  readonly computeNode: ComputeNode;
  /** RIGGED, animated near/mid-band crowd (T128): GPU-skinned InstancedMesh per archetype, baked from a bone
   *  texture. Until every archetype GLB has baked + attached it draws nothing (no boxes during the ~1s gap). */
  readonly rigged: RiggedCrowd;
  /** FAR-band billboard IMPOSTOR lane (T140): one instanced quad per archetype sampling a baked yaw atlas. */
  readonly impostor: CrowdImpostors;

  /** Reused scratch for the per-frame distance band mask (avoids a per-frame allocation). */
  private maskScratch?: Uint8Array;
  private readonly noopBuffer: StorageBufferNode<'float'>;

  constructor(settings: CrowdSettings, registry: ResourceRegistry) {
    this.settings = settings;
    this.mesh = new Group();
    this.mesh.name = 'crowd.root';

    this.impostor = new CrowdImpostors(settings, this.mesh, {
      angleCount: settings.impostorAngleCount,
      tileH: settings.impostorTileHeight,
      maxTriangles: settings.impostorMaxTriangles,
      heightMeters: RIGGED_HEIGHT_METERS,
    });
    this.rigged = new RiggedCrowd(settings, this.mesh, this.impostor);

    // No-op compute (see computeNode doc) — a 1-element storage write so `host.compute(computeNode)` is valid.
    this.noopBuffer = registry.track(instancedArray(new Float32Array(1), 'float'), 'buffer', 'crowd.noopCompute');
    this.computeNode = Fn(() => {
      this.noopBuffer.element(instanceIndex).assign(float(0));
    })().compute(1);
  }

  /**
   * Partition the live crowd by DISTANCE into the rigged (near) + impostor (far) lanes and drive both. The anchor
   * (playerX/playerZ) is the LOD origin. Until the rigged lane is ready (all archetype GLBs baked) NOTHING is drawn
   * (the pre-bake gap shows no boxes; the blob CorpseField covers corpses). Returns the total drawn instance count.
   */
  update(views: FieldViews, count: number, dtSeconds: number, playerX: number, playerZ: number, visibility?: VisionCull): number {
    this.maskScratch = computeDistanceBand(views, count, playerX, playerZ, this.settings.riggedMaxDistance, this.maskScratch);
    const mask = this.maskScratch;
    if (!this.rigged.isReady) {
      this.rigged.hide();
      this.impostor.hide();
      return 0;
    }
    const near = this.rigged.update(views, count, dtSeconds, visibility, mask);
    const far = this.impostor.update(views, count, visibility, mask);
    return near + far;
  }

  /** V102: the per-instance SIZE scale this crowd renders zombie `slot` at — the SAME `variationScale` the packing
   *  applies. Body-anchored gore reads it so a wound sits at the right height/scale. Pure + stable per slot (V26). */
  scaleOf(slot: number): number {
    const c = Math.max(1, this.settings.variationCount);
    return variationScale(variationSeed(slot, c), c, this.settings.scaleMin, this.settings.scaleMax);
  }
}
