// T146 — molotov fire-pool visual. Per active pool: a soft warm ground-glow (additive soft-disc on a PLANE — a
// CircleGeometry would cut the falloff at its rim into a hard red disc, the prior bug), a ring of flickering
// ADDITIVE flame billboards (noise-warped `makeFlameTextures` variants → organic, not repeated teardrops), and a
// few rising SMOKE puffs (NormalBlending, fade as they climb). Render-only (V2): reads pool centres/radii, never
// writes sim state. Shared geo + per-layer materials; smoke clones one material per puff for independent fade.
// V24-tracked. Pool is fixed-size (a handful of molotovs at once); excess pools share slots.

import { AdditiveBlending, Group, Mesh, MeshBasicMaterial, NormalBlending, PlaneGeometry, Sprite, SpriteMaterial } from 'three';
import type { Disposable, ResourceKind } from '../engine/resources';
import { makeFlameTextures, makeSmokeTexture, makeSoftDiscTexture } from './fireTextures';

type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;
type Pool = { readonly x: number; readonly z: number; readonly radius: number };

const MAX_POOLS = 8;
const FLAMES_PER_POOL = 6;
const SMOKE_PER_POOL = 3;
const VARIANTS = 4;

// Deterministic per-index offset inside the unit disc (golden-angle spiral → even spread, biased toward centre).
function unitOffset(i: number): { x: number; z: number; r: number } {
  const a = (i * 2.39996323) % (Math.PI * 2);
  const r = Math.sqrt((i * 0.61803399) % 1) * 0.8;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r, r };
}

export class FirePoolView {
  readonly group = new Group();
  private readonly glows: Mesh[] = [];
  private readonly flames: Sprite[][] = [];
  private readonly smoke: { sprite: Sprite; mat: SpriteMaterial }[][] = [];
  private clock = 0;

  constructor(track: TrackFn) {
    this.group.name = 'firePools';
    const planeGeo = new PlaneGeometry(1, 1);
    const discTex = makeSoftDiscTexture();
    const smokeTex = makeSmokeTexture();
    const flameTexs = makeFlameTextures(VARIANTS);
    track(planeGeo, 'geometry', 'firePool.plane.geo');
    track(discTex, 'texture', 'firePool.disc.tex');
    track(smokeTex, 'texture', 'firePool.smoke.tex');
    flameTexs.forEach((t, i) => track(t, 'texture', `firePool.flame.tex.${i}`));
    const glowMat = new MeshBasicMaterial({
      map: discTex,
      color: 0xff5a18,
      blending: AdditiveBlending,
      transparent: true,
      opacity: 0.42, // gentle warm pool — NOT the prior opaque red wash
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    track(glowMat, 'material', 'firePool.glow.mat');
    const flameMats = flameTexs.map((map, i) => {
      const m = new SpriteMaterial({ map, blending: AdditiveBlending, transparent: true, opacity: 0.85, depthWrite: false });
      track(m, 'material', `firePool.flame.mat.${i}`);
      return m;
    });
    for (let i = 0; i < MAX_POOLS; i++) {
      const glow = new Mesh(planeGeo, glowMat);
      glow.rotation.x = -Math.PI / 2; // flat on the ground
      glow.renderOrder = 3;
      glow.visible = false;
      this.group.add(glow);
      this.glows.push(glow);
      const row: Sprite[] = [];
      for (let j = 0; j < FLAMES_PER_POOL; j++) {
        const s = new Sprite(flameMats[(i + j) % VARIANTS]);
        s.visible = false;
        this.group.add(s);
        row.push(s);
      }
      this.flames.push(row);
      const srow: { sprite: Sprite; mat: SpriteMaterial }[] = [];
      for (let j = 0; j < SMOKE_PER_POOL; j++) {
        const mat = new SpriteMaterial({ map: smokeTex, color: 0x2b2622, blending: NormalBlending, transparent: true, opacity: 0, depthWrite: false });
        track(mat, 'material', `firePool.smoke.mat.${i}.${j}`);
        const s = new Sprite(mat);
        s.visible = false;
        this.group.add(s);
        srow.push({ sprite: s, mat });
      }
      this.smoke.push(srow);
    }
  }

  /** Position + flicker the glow, flame ring, and rising smoke for each active fire pool (seated on `groundY`); hide the rest. */
  sync(pools: readonly Pool[], groundY: number, dtSeconds: number): void {
    this.clock += Math.max(0, dtSeconds);
    for (let i = 0; i < this.glows.length; i++) {
      const glow = this.glows[i]!;
      const row = this.flames[i]!;
      const srow = this.smoke[i]!;
      const p = pools[i];
      if (!p) {
        glow.visible = false;
        for (const s of row) s.visible = false;
        for (const s of srow) { s.sprite.visible = false; }
        continue;
      }
      // Ground glow (plane): soft, gently pulsing, ~pool-sized.
      glow.visible = true;
      glow.position.set(p.x, groundY + 0.03, p.z);
      const tg = this.clock + i * 1.7;
      const pulse = 1 + 0.1 * Math.sin(tg * 5) + 0.05 * Math.sin(tg * 17);
      glow.scale.set(p.radius * 2.4 * pulse, p.radius * 2.4 * pulse, 1);
      // Flame ring.
      for (let j = 0; j < row.length; j++) {
        const s = row[j]!;
        s.visible = true;
        const off = unitOffset(i * 31 + j * 7 + 3);
        const ox = off.x * p.radius;
        const oz = off.z * p.radius;
        const t = this.clock * 6 + (i * 4 + j) * 1.7;
        const base = (1 - off.r * 0.45) * Math.min(2.3, p.radius * 0.95 + 0.7);
        const h = base * (0.82 + 0.28 * Math.sin(t) + 0.13 * Math.sin(t * 3.3 + j));
        const w = Math.max(0.34, h * 0.48);
        s.scale.set(w, Math.max(0.5, h), 1);
        s.position.set(p.x + ox, groundY + s.scale.y * 0.5, p.z + oz);
      }
      // Rising smoke: each puff loops base→up, expanding + fading in then out; tinted dark, light opacity.
      const rise = Math.min(3.4, p.radius + 1.6);
      for (let j = 0; j < srow.length; j++) {
        const { sprite, mat } = srow[j]!;
        const prog = ((this.clock * 0.32 + j / srow.length + i * 0.13) % 1 + 1) % 1; // 0..1 loop
        const off = unitOffset(i * 17 + j * 5 + 1);
        const grow = 0.7 + prog * 1.5;
        const size = Math.max(0.6, p.radius * 0.8) * grow;
        // fade in over the first third, out over the last third.
        const fade = Math.min(prog / 0.25, (1 - prog) / 0.45, 1);
        mat.opacity = 0.34 * Math.max(0, fade);
        sprite.visible = mat.opacity > 0.01;
        sprite.scale.set(size, size, 1);
        sprite.position.set(
          p.x + off.x * p.radius * 0.4 + Math.sin(this.clock * 0.6 + j) * 0.25,
          groundY + 0.6 + prog * rise + size * 0.3,
          p.z + off.z * p.radius * 0.4,
        );
      }
    }
  }
}
