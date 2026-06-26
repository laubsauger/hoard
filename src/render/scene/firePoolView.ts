// T146 — molotov fire-pool ground visual (INTERIM; S4 upgrades these to the volumetric fire). A small pool of
// emissive orange discs laid flat on the ground at each `runtime.firePoolMarkers()` position, flicker-pulsed.
// Render-only (V2): reads pool centres/radii, never writes sim state. Shared geometry; per-disc material clones
// give each an independent flicker. Pool is fixed-size (a handful of molotovs at once); excess pools share discs.

import { CircleGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import type { Disposable, ResourceKind } from '../engine/resources';

type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;

const MAX_POOLS = 8;

export class FirePoolView {
  readonly group = new Group();
  private readonly discs: Mesh[] = [];
  private readonly mats: MeshStandardMaterial[] = [];
  private clock = 0;

  constructor(track: TrackFn) {
    this.group.name = 'firePools';
    const geo = new CircleGeometry(1, 20); // unit disc; scaled to each pool's radius
    track(geo, 'geometry', 'firePool.geo');
    for (let i = 0; i < MAX_POOLS; i++) {
      const mat = new MeshStandardMaterial({
        color: 0xff6a1a,
        emissive: 0xff7a1a,
        emissiveIntensity: 2.4,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      });
      track(mat, 'material', `firePool.mat.${i}`);
      const m = new Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2; // flat on the ground
      m.renderOrder = 3;
      m.visible = false;
      this.group.add(m);
      this.discs.push(m);
      this.mats.push(mat);
    }
  }

  /** Position + flicker one disc per active fire pool (seated on `groundY`); hide the rest. */
  sync(pools: readonly { readonly x: number; readonly z: number; readonly radius: number }[], groundY: number, dtSeconds: number): void {
    this.clock += Math.max(0, dtSeconds);
    for (let i = 0; i < this.discs.length; i++) {
      const m = this.discs[i]!;
      const p = pools[i];
      if (!p) {
        m.visible = false;
        this.mats[i]!.opacity = 0;
        continue;
      }
      m.visible = true;
      m.position.set(p.x, groundY + 0.03, p.z);
      m.scale.setScalar(p.radius);
      // two-rate flicker (slow swell + fast jitter), per-disc phase from its index.
      const t = this.clock + i * 1.7;
      const flicker = 0.6 + 0.25 * Math.sin(t * 5.0) + 0.15 * Math.sin(t * 17.0);
      this.mats[i]!.opacity = Math.max(0.25, Math.min(0.9, flicker));
    }
  }
}
