// T85 — visual markers for DROPPED floor piles. A small pool of low boxes (one shared geometry + material,
// V24-tracked) shown/positioned each frame from `runtime.floorPileMarkers()` so dropped items are visible on the
// ground (and lootable via the existing container interactable). Render-only (V2): reads marker positions, never
// writes world state. The pool is fixed-size — excess piles beyond the cap simply aren't drawn (logged by caller).

import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import type { Disposable, ResourceKind } from '../engine/resources';

type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;

/** Max simultaneously-rendered floor piles (drops past this still EXIST + loot, they just lack a marker). */
const MAX_PILES = 48;

export class FloorPileView {
  readonly group = new Group();
  private readonly boxes: Mesh[] = [];

  constructor(track: TrackFn) {
    this.group.name = 'floorPiles';
    const geo = new BoxGeometry(0.34, 0.16, 0.34);
    const mat = new MeshStandardMaterial({ color: 0x5a4632, metalness: 0, roughness: 0.9 });
    track(geo, 'geometry', 'floorPile.geo');
    track(mat, 'material', 'floorPile.mat');
    for (let i = 0; i < MAX_PILES; i++) {
      const m = new Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      m.visible = false;
      this.group.add(m);
      this.boxes.push(m);
    }
  }

  /** Show + position one marker per pile (resting on `groundY`); hide the unused remainder of the pool. */
  sync(markers: readonly { readonly x: number; readonly z: number }[], groundY: number): void {
    for (let i = 0; i < this.boxes.length; i++) {
      const m = this.boxes[i]!;
      const p = markers[i];
      if (p) {
        m.visible = true;
        m.position.set(p.x, groundY + 0.08, p.z);
      } else {
        m.visible = false;
      }
    }
  }
}
