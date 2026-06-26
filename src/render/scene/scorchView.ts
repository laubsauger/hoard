// T142 — charred scorch decals left where a grenade exploded. A ring buffer of RAGGED blast splats laid flat on the
// ground (polygon-offset so they sit on the floor without z-fighting); a fresh blast claims the next slot, recycling
// the oldest once the pool wraps. The mark is a baked irregular soot texture (`makeScorchTexture`) on a PLANE — NOT a
// CircleGeometry, whose rim cut the soft falloff into a hard perfect circle (the prior bug). Each stamp gets a random
// in-plane spin so repeats don't read identical. Persistent (no fade) — the world remembers the blast. Render-only
// (V2): placed from blast points, never reads/writes sim state. Shared geometry + material + texture (V24).

import { Group, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';
import type { Disposable, ResourceKind } from '../engine/resources';
import { makeScorchTexture } from './fireTextures';

type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;

const MAX_SCORCHES = 24;

export class ScorchView {
  readonly group = new Group();
  private readonly discs: Mesh[] = [];
  private next = 0;

  constructor(track: TrackFn, radiusMeters: number) {
    this.group.name = 'scorches';
    // Plane spans ~2.7× the blast radius; the baked soot occupies the inner ~⅓ with a transparent, ragged border.
    const span = radiusMeters * 2.7;
    const geo = new PlaneGeometry(span, span);
    const tex = makeScorchTexture();
    const mat = new MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    track(geo, 'geometry', 'scorch.geo');
    track(tex, 'texture', 'scorch.tex');
    track(mat, 'material', 'scorch.mat');
    for (let i = 0; i < MAX_SCORCHES; i++) {
      const m = new Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2; // lay flat on the ground (XZ plane, facing up)
      m.visible = false;
      m.renderOrder = 2;
      this.group.add(m);
      this.discs.push(m);
    }
  }

  /** Stamp a scorch on the ground at (x,z) (seated just above `groundY`). Recycles the oldest once the pool wraps. */
  spawn(x: number, groundY: number, z: number): void {
    const m = this.discs[this.next]!;
    this.next = (this.next + 1) % this.discs.length;
    m.position.set(x, groundY + 0.02, z);
    m.rotation.z = Math.random() * Math.PI * 2; // random in-plane spin so repeats don't look identical
    m.visible = true;
  }
}
