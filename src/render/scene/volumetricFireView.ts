// T149 — tiered volumetric fire. A SMALL pool of raymarched fire boxes (the expensive tier) assigned to the
// fire pools NEAREST the camera; pools beyond the budget keep the cheap `FirePoolView` discs, so a 6th fire never
// vanishes — it just loses the volume (the no-cliff plan). Render-only (V2). The box geo + each fire material are
// V24-tracked. `MAX_VOLUMES` is the per-tier budget (kept small — raymarch cost scales with on-screen pixels).

import { Group } from 'three';
import type { Disposable, ResourceKind } from '../engine/resources';
import { buildVolumetricFireMesh, type VolumetricFireUniforms } from './volumetricFire';

type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;
type Pool = { readonly x: number; readonly z: number; readonly radius: number };

const FIRE_HEIGHT_METERS = 2.6;

export class VolumetricFireView {
  readonly group = new Group();
  private readonly fires: { mesh: import('three').Mesh; uniforms: VolumetricFireUniforms }[] = [];
  private clock = 0;

  constructor(track: TrackFn, maxVolumes: number) {
    this.group.name = 'volumetricFire';
    for (let i = 0; i < Math.max(0, maxVolumes); i++) {
      const f = buildVolumetricFireMesh();
      track(f.mesh.geometry as unknown as Disposable, 'geometry', `volFire.geo.${i}`);
      track(f.mesh.material as unknown as Disposable, 'material', `volFire.mat.${i}`);
      this.group.add(f.mesh);
      this.fires.push(f as { mesh: import('three').Mesh; uniforms: VolumetricFireUniforms });
    }
  }

  /** Assign the volume boxes to the fire pools nearest the camera; size + drive each fire's uniforms; hide the rest. */
  sync(pools: readonly Pool[], groundY: number, dtSeconds: number, cameraX: number, cameraZ: number): void {
    if (this.fires.length === 0) return;
    this.clock += Math.max(0, dtSeconds);
    const nearest = [...pools]
      .sort((a, b) => (a.x - cameraX) ** 2 + (a.z - cameraZ) ** 2 - ((b.x - cameraX) ** 2 + (b.z - cameraZ) ** 2))
      .slice(0, this.fires.length);
    for (let i = 0; i < this.fires.length; i++) {
      const f = this.fires[i]!;
      const p = nearest[i];
      if (!p) {
        f.mesh.visible = false;
        continue;
      }
      const h = FIRE_HEIGHT_METERS;
      f.mesh.visible = true;
      f.mesh.position.set(p.x, groundY + h * 0.5, p.z);
      f.mesh.scale.set(p.radius * 2.6, h, p.radius * 2.6); // box must contain the marched volume
      f.uniforms.time.value = this.clock;
      f.uniforms.baseY.value = groundY;
      f.uniforms.centreX.value = p.x;
      f.uniforms.centreZ.value = p.z;
      f.uniforms.height.value = h;
      f.uniforms.radius.value = p.radius;
      f.uniforms.strength.value = 1;
    }
  }
}
