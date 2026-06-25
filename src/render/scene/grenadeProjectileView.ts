// T142 — visible thrown-grenade projectiles. A small pool of dark spheres synced each frame to
// `runtime.grenadeProjectiles()` (the sim computes the arcing position; this just draws it). When a grenade
// detonates the sim drops it from the list → its sphere hides + the explosion takes over. Render-only (V2).

import { Group, Mesh, MeshStandardMaterial, SphereGeometry } from 'three';
import type { Disposable, ResourceKind } from '../engine/resources';

type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;

const MAX_PROJECTILES = 8;

export class GrenadeProjectileView {
  readonly group = new Group();
  private readonly spheres: Mesh[] = [];

  constructor(track: TrackFn) {
    this.group.name = 'grenades';
    const geo = new SphereGeometry(0.09, 12, 8);
    const mat = new MeshStandardMaterial({ color: 0x36401e, metalness: 0.35, roughness: 0.6 }); // dark olive
    track(geo, 'geometry', 'grenade.geo');
    track(mat, 'material', 'grenade.mat');
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const m = new Mesh(geo, mat);
      m.castShadow = true;
      m.visible = false;
      this.group.add(m);
      this.spheres.push(m);
    }
  }

  /** Show + position one sphere per in-flight grenade; hide the rest of the pool. */
  sync(projectiles: readonly { readonly x: number; readonly y: number; readonly z: number }[]): void {
    for (let i = 0; i < this.spheres.length; i++) {
      const m = this.spheres[i]!;
      const p = projectiles[i];
      if (p) {
        m.visible = true;
        m.position.set(p.x, p.y, p.z);
      } else {
        m.visible = false;
      }
    }
  }
}
