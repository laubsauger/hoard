// T148 — visible flames on BURNING zombies (the gap since the burn sim, T145). Per burning zombie a pair of
// ADDITIVE flame billboards (a wide soft back layer + a narrower hotter front layer, flickered out of phase) using
// the baked `makeFlameTexture` heat-ramp — soft alpha → 0 before the quad edge, so a burning horde reads as fire,
// NOT the stack of flat squares the mapless SpriteMaterial used to draw. Sprites are cheap + scale to a whole horde
// on fire (a molotov chain), so this is the always-on tier (no distance cliff). Render-only (V2); one shared
// material per layer (flicker is per-sprite SCALE, no clones), V24-tracked.

import { AdditiveBlending, Group, Sprite, SpriteMaterial } from 'three';
import type { Disposable, ResourceKind } from '../engine/resources';
import { makeFlameTexture } from './fireTextures';

type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;

const MAX_FLAMES = 64; // a burning horde can be many; billboards are cheap

export class BurningZombieView {
  readonly group = new Group();
  private readonly back: Sprite[] = [];
  private readonly front: Sprite[] = [];
  private clock = 0;

  constructor(track: TrackFn) {
    this.group.name = 'burningZombies';
    const tex = makeFlameTexture();
    track(tex, 'texture', 'burn.flame.tex');
    // Colour stays white so the texture's baked heat ramp shows through; additive over the scene = glow.
    const backMat = new SpriteMaterial({ map: tex, blending: AdditiveBlending, transparent: true, opacity: 0.55, depthWrite: false });
    const frontMat = new SpriteMaterial({ map: tex, blending: AdditiveBlending, transparent: true, opacity: 0.9, depthWrite: false });
    track(backMat, 'material', 'burn.flame.back.mat');
    track(frontMat, 'material', 'burn.flame.front.mat');
    for (let i = 0; i < MAX_FLAMES; i++) {
      const b = new Sprite(backMat);
      const f = new Sprite(frontMat);
      b.visible = false;
      f.visible = false;
      this.group.add(b);
      this.group.add(f);
      this.back.push(b);
      this.front.push(f);
    }
  }

  /** Place a flickering two-layer flame on each burning zombie (anchored at the torso); hide the rest of the pool. */
  sync(positions: readonly { readonly x: number; readonly y: number; readonly z: number }[], dtSeconds: number): void {
    this.clock += Math.max(0, dtSeconds);
    for (let i = 0; i < this.back.length; i++) {
      const b = this.back[i]!;
      const f = this.front[i]!;
      const p = positions[i];
      if (!p) {
        b.visible = false;
        f.visible = false;
        continue;
      }
      b.visible = true;
      f.visible = true;
      // Sprite anchor is the centre; the texture's base is at the bottom, so lift by ~half the height to seat it on the body.
      const t = this.clock * 7 + i * 1.9;
      const hb = 1.55 + 0.3 * Math.sin(t) + 0.16 * Math.sin(t * 2.7);
      const hf = 1.15 + 0.28 * Math.sin(t * 1.6 + 1.1) + 0.14 * Math.sin(t * 4.3);
      b.scale.set(1.15, Math.max(0.9, hb), 1);
      f.scale.set(0.78, Math.max(0.7, hf), 1);
      b.position.set(p.x, p.y + 0.5 + b.scale.y * 0.5, p.z);
      f.position.set(p.x, p.y + 0.55 + f.scale.y * 0.5, p.z);
    }
  }
}
