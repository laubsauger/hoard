// T147 — torch world visuals: planted-torch PROP meshes (a post + an emissive flame) at every
// `runtime.placedTorchMarkers()`, plus a small pool of warm POINT LIGHTS assigned to the highest-priority torch
// flames (the held torch when equipped + the placed torches nearest the camera). Lights are PRE-POOLED + kept
// permanently visible, pulsed by INTENSITY (0 = off) — never toggled visible, so they never trigger the WebGPU
// material recompile / freeze (cf. the flashlight fix). Render-only (V2). Shared geo/materials; V24-tracked.

import { Color, CylinderGeometry, Group, Mesh, MeshStandardMaterial, PointLight, SphereGeometry } from 'three';
import type { Disposable, ResourceKind } from '../engine/resources';

type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;
type Pt = { readonly x: number; readonly z: number };

const MAX_PROPS = 24; // planted-torch meshes
const MAX_LIGHTS = 5; // pooled warm point lights (held + nearest placed)
const LIGHT_RANGE = 9;
const LIGHT_INTENSITY = 5;

export class TorchView {
  readonly group = new Group();
  private readonly props: Group[] = [];
  private readonly lights: PointLight[] = [];
  private clock = 0;

  constructor(track: TrackFn) {
    this.group.name = 'torches';
    const wood = new MeshStandardMaterial({ color: 0x5a4632, roughness: 0.9, metalness: 0 });
    const flameMat = new MeshStandardMaterial({ color: 0xff8a2a, emissive: 0xff7a1a, emissiveIntensity: 3, transparent: true, opacity: 0.92, depthWrite: false });
    track(wood, 'material', 'torch.mat.wood');
    track(flameMat, 'material', 'torch.mat.flame');
    const postGeo = new CylinderGeometry(0.03, 0.045, 0.7, 8);
    const flameGeo = new SphereGeometry(0.12, 10, 8);
    track(postGeo, 'geometry', 'torch.geo.post');
    track(flameGeo, 'geometry', 'torch.geo.flame');
    for (let i = 0; i < MAX_PROPS; i++) {
      const g = new Group();
      const post = new Mesh(postGeo, wood);
      post.position.y = 0.35;
      post.castShadow = true;
      const flame = new Mesh(flameGeo, flameMat);
      flame.position.y = 0.78;
      flame.scale.set(1, 1.5, 1);
      g.add(post, flame);
      g.visible = false;
      this.group.add(g);
      this.props.push(g);
    }
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = new PointLight(new Color(1, 0.62, 0.28), 0, LIGHT_RANGE);
      l.castShadow = false;
      // permanently visible (intensity 0 when idle) so the active-light count never changes → no pipeline recompile.
      this.group.add(l);
      this.lights.push(l);
      track(l, 'other', `torch.light.${i}`);
    }
  }

  /**
   * Place props at every placed torch; assign the pooled lights to the held torch (if equipped, at the player) +
   * the placed torches NEAREST the camera, pulsed with a warm flicker. `heldAt` is the player position when a
   * torch is the active weapon, else null.
   */
  sync(placed: readonly Pt[], heldAt: Pt | null, groundY: number, dtSeconds: number, cameraX: number, cameraZ: number): void {
    this.clock += Math.max(0, dtSeconds);
    // props for every placed torch (visual presence is unbounded up to the prop pool).
    for (let i = 0; i < this.props.length; i++) {
      const p = placed[i];
      const g = this.props[i]!;
      if (p) {
        g.visible = true;
        g.position.set(p.x, groundY, p.z);
      } else {
        g.visible = false;
      }
    }
    // light sources, highest priority first: the held torch, then placed torches by camera distance.
    const sources: { x: number; z: number; y: number }[] = [];
    if (heldAt) sources.push({ x: heldAt.x, z: heldAt.z, y: groundY + 1.1 });
    const byDist = [...placed].sort(
      (a, b) => (a.x - cameraX) ** 2 + (a.z - cameraZ) ** 2 - ((b.x - cameraX) ** 2 + (b.z - cameraZ) ** 2),
    );
    for (const p of byDist) sources.push({ x: p.x, z: p.z, y: groundY + 0.78 });
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i]!;
      const s = sources[i];
      if (!s) {
        l.intensity = 0;
        continue;
      }
      l.position.set(s.x, s.y, s.z);
      const t = this.clock * 7 + i * 2.1;
      l.intensity = LIGHT_INTENSITY * (0.82 + 0.12 * Math.sin(t) + 0.06 * Math.sin(t * 3.3)); // warm flicker
    }
  }
}
