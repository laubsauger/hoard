// T142 — charred scorch decals left where a grenade exploded. A ring buffer of dark flat discs laid on the
// ground (polygon-offset so they sit on the floor without z-fighting); a fresh blast claims the next slot,
// recycling the oldest once the pool wraps. Persistent discolouration (no fade) — the world remembers the blast.
// Render-only (V2): placed from blast points, never reads/writes sim state. Shared geometry + material (V24).

import { CircleGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import type { Disposable, ResourceKind } from '../engine/resources';
import { makeSoftDiscTexture } from './fireTextures';

type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;

const MAX_SCORCHES = 24;

export class ScorchView {
  readonly group = new Group();
  private readonly discs: Mesh[] = [];
  private next = 0;

  constructor(track: TrackFn, radiusMeters: number) {
    this.group.name = 'scorches';
    const geo = new CircleGeometry(radiusMeters, 32);
    // Soft-alpha map (white centre → transparent rim) drives the opacity so the soot FADES into the ground instead
    // of a hard-edged disc slapped on top. alphaMap samples .g (white here); darkest at the crater, gone at the rim.
    const alphaTex = makeSoftDiscTexture();
    track(alphaTex, 'texture', 'scorch.alpha.tex');
    // Charred near-black, matte, slightly translucent so the floor texture still reads under the soot.
    const mat = new MeshStandardMaterial({
      color: 0x130d08,
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0.72,
      alphaMap: alphaTex,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    track(geo, 'geometry', 'scorch.geo');
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
