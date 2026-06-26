// T148 — visible flames on BURNING zombies (the gap since the burn sim, T145). Per burning zombie a pair of
// ADDITIVE flame billboards (a wide soft back layer + a narrower hotter front layer, flickered out of phase) drawn
// from a SET of noise-warped flame textures (`makeFlameTextures`) — each zombie gets a different variant pair so a
// burning horde is a field of irregular licks, not repeated identical teardrops. Mipmaps off + a baked transparent
// border mean no quad box shows even against a light street (the prior artifact). Sprites are cheap + scale to a
// whole horde on fire (a molotov chain), so this is the always-on tier (no distance cliff). Render-only (V2);
// VARIANTS shared materials (flicker is per-sprite SCALE, no clones), V24-tracked.

import { AdditiveBlending, Group, Sprite, SpriteMaterial } from 'three';
import type { Disposable, ResourceKind } from '../engine/resources';
import { makeFlameTextures } from './fireTextures';

type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;

const MAX_FLAMES = 64; // a burning horde can be many; billboards are cheap
const VARIANTS = 4;

export class BurningZombieView {
  readonly group = new Group();
  private readonly back: Sprite[] = [];
  private readonly front: Sprite[] = [];
  private clock = 0;

  constructor(track: TrackFn) {
    this.group.name = 'burningZombies';
    const texs = makeFlameTextures(VARIANTS);
    texs.forEach((t, i) => track(t, 'texture', `burn.flame.tex.${i}`));
    // One material per variant per layer; colour stays white so each texture's baked heat ramp shows. Additive = glow.
    const backMats = texs.map((map, i) => {
      const m = new SpriteMaterial({ map, blending: AdditiveBlending, transparent: true, opacity: 0.5, depthWrite: false });
      track(m, 'material', `burn.flame.back.mat.${i}`);
      return m;
    });
    const frontMats = texs.map((map, i) => {
      const m = new SpriteMaterial({ map, blending: AdditiveBlending, transparent: true, opacity: 0.9, depthWrite: false });
      track(m, 'material', `burn.flame.front.mat.${i}`);
      return m;
    });
    for (let i = 0; i < MAX_FLAMES; i++) {
      const b = new Sprite(backMats[i % VARIANTS]);
      const f = new Sprite(frontMats[(i + 2) % VARIANTS]); // offset so the two layers differ
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
      const hb = 1.5 + 0.32 * Math.sin(t) + 0.18 * Math.sin(t * 2.7 + i);
      const hf = 1.1 + 0.3 * Math.sin(t * 1.6 + 1.1) + 0.15 * Math.sin(t * 4.3 + i);
      const wb = 0.95 + 0.08 * Math.sin(t * 1.3);
      b.scale.set(wb, Math.max(0.9, hb), 1);
      f.scale.set(0.74 + 0.06 * Math.sin(t * 2.1), Math.max(0.7, hf), 1);
      b.position.set(p.x, p.y + 0.5 + b.scale.y * 0.5, p.z);
      f.position.set(p.x, p.y + 0.55 + f.scale.y * 0.5, p.z);
    }
  }
}
