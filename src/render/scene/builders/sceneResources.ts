// Tracked GPU-resource factory for scene construction. Every material/geometry a builder creates goes through
// here so it is (a) registered with the ResourceRegistry for disposal (V24) and (b) counted for diagnostics.
// Extracted from BlockScene so the builders can create resources without owning a god-object (the BlockScene
// decomposition; see docs/REFACTOR-godfiles.md). No GPU device needed — pure CPU object construction.

import { MeshStandardMaterial, type BufferGeometry, type BoxGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Disposable, ResourceKind, ResourceRegistry } from '../../engine/resources';

export class SceneResources {
  private readonly mats: MeshStandardMaterial[] = [];
  private readonly geos: BufferGeometry[] = [];

  constructor(private readonly registry: ResourceRegistry) {}

  /** Track an arbitrary disposable (InstancedMesh buffers, lights, etc) for V24 disposal. Label namespaced
   *  `block.<label>`. Builders use this for instanced meshes; mat/geo cover the common material/geometry path. */
  track<T extends Disposable>(resource: T, kind: ResourceKind, label: string): T {
    return this.registry.track(resource, kind, `block.${label}`);
  }

  /** Create + track a MeshStandardMaterial. Label is namespaced `block.<label>` for registry diagnostics. */
  mat(label: string, opts: ConstructorParameters<typeof MeshStandardMaterial>[0]): MeshStandardMaterial {
    const m = this.registry.track(new MeshStandardMaterial(opts), 'material', `block.${label}`);
    this.mats.push(m);
    return m;
  }

  /** Track + return a geometry (created by the caller). */
  geo<T extends BufferGeometry>(label: string, g: T): T {
    this.registry.track(g, 'geometry', `block.${label}`);
    this.geos.push(g);
    return g;
  }

  /** Merge a batch of boxes into ONE tracked geometry (disposing the inputs). Null when the batch is empty. */
  mergeBoxes(label: string, boxes: BoxGeometry[]): BufferGeometry | null {
    if (boxes.length === 0) return null;
    const merged = mergeGeometries(boxes, false);
    for (const b of boxes) b.dispose();
    return merged ? this.geo(label, merged) : null;
  }

  get materialCount(): number {
    return this.mats.length;
  }
  get geometryCount(): number {
    return this.geos.length;
  }
}
