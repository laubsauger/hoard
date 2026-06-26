// T148 — visible flames on BURNING zombies (the gap since the burn sim, T145). A pool of additive warm sprites
// (auto camera-facing) placed at each `runtime.burningZombiePositions()`, scale-flickered like fire. Sprites are
// cheap + scale to a whole horde on fire (a molotov chain), so this is the unconditional billboard tier — the
// volumetric raymarch (S4 stretch) would be an LOD upgrade on top for the nearest few. Render-only (V2); one
// shared additive material (no per-sprite clones — flicker is per-sprite SCALE), V24-tracked.

import { AdditiveBlending, Group, Sprite, SpriteMaterial } from 'three';
import type { Disposable, ResourceKind } from '../engine/resources';

type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;

const MAX_FLAMES = 64; // a burning horde can be many; billboards are cheap

export class BurningZombieView {
  readonly group = new Group();
  private readonly sprites: Sprite[] = [];
  private clock = 0;

  constructor(track: TrackFn) {
    this.group.name = 'burningZombies';
    const mat = new SpriteMaterial({ color: 0xff7a1a, blending: AdditiveBlending, transparent: true, opacity: 0.85, depthWrite: false });
    track(mat, 'material', 'burn.flame.mat');
    for (let i = 0; i < MAX_FLAMES; i++) {
      const s = new Sprite(mat);
      s.visible = false;
      this.group.add(s);
      this.sprites.push(s);
    }
  }

  /** Place a flickering flame sprite on each burning zombie (lifted to the torso); hide the rest of the pool. */
  sync(positions: readonly { readonly x: number; readonly y: number; readonly z: number }[], dtSeconds: number): void {
    this.clock += Math.max(0, dtSeconds);
    for (let i = 0; i < this.sprites.length; i++) {
      const s = this.sprites[i]!;
      const p = positions[i];
      if (!p) {
        s.visible = false;
        continue;
      }
      s.visible = true;
      s.position.set(p.x, p.y + 1.05, p.z); // flame around the torso/head
      // per-sprite two-rate flicker on the vertical scale (the flame licks up + jitters), width steadier.
      const t = this.clock * 9 + i * 1.9;
      const h = 1.4 + 0.35 * Math.sin(t) + 0.18 * Math.sin(t * 3.7);
      s.scale.set(0.9, Math.max(0.8, h), 1);
    }
  }
}
