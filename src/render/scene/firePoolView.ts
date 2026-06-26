// T146 — molotov fire-pool visual. Per active pool: a soft warm ground-glow disc (additive, soft-alpha map so it
// fades at the rim, NOT a hard ring) plus a ring of flickering ADDITIVE flame billboards (the baked heat-ramp
// `makeFlameTexture`) licking up across the pool radius. Render-only (V2): reads pool centres/radii, never writes
// sim state. Shared geometry + one material per layer (flicker is per-object SCALE, no clones); V24-tracked. Pool is
// fixed-size (a handful of molotovs at once); excess pools share slots.

import { AdditiveBlending, CircleGeometry, Group, Mesh, MeshBasicMaterial, Sprite, SpriteMaterial } from 'three';
import type { Disposable, ResourceKind } from '../engine/resources';
import { makeFlameTexture, makeSoftDiscTexture } from './fireTextures';

type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;
type Pool = { readonly x: number; readonly z: number; readonly radius: number };

const MAX_POOLS = 8;
const FLAMES_PER_POOL = 5;

// Deterministic per-(pool,flame) offsets inside the unit disc, so flames spread across the pool without per-frame jitter.
function unitOffset(i: number): { x: number; z: number; r: number } {
  const a = (i * 2.39996323) % (Math.PI * 2); // golden-angle spiral → even spread
  const r = Math.sqrt(((i * 0.61803399) % 1)) * 0.8; // bias toward centre, stay inside the rim
  return { x: Math.cos(a) * r, z: Math.sin(a) * r, r };
}

export class FirePoolView {
  readonly group = new Group();
  private readonly glows: Mesh[] = [];
  private readonly flames: Sprite[][] = [];
  private clock = 0;

  constructor(track: TrackFn) {
    this.group.name = 'firePools';
    const discGeo = new CircleGeometry(1, 24); // unit disc; scaled to each pool's radius
    const discTex = makeSoftDiscTexture();
    const flameTex = makeFlameTexture();
    track(discGeo, 'geometry', 'firePool.disc.geo');
    track(discTex, 'texture', 'firePool.disc.tex');
    track(flameTex, 'texture', 'firePool.flame.tex');
    const glowMat = new MeshBasicMaterial({
      map: discTex,
      color: 0xff6a1a,
      blending: AdditiveBlending,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const flameMat = new SpriteMaterial({ map: flameTex, blending: AdditiveBlending, transparent: true, opacity: 0.85, depthWrite: false });
    track(glowMat, 'material', 'firePool.glow.mat');
    track(flameMat, 'material', 'firePool.flame.mat');
    for (let i = 0; i < MAX_POOLS; i++) {
      const glow = new Mesh(discGeo, glowMat);
      glow.rotation.x = -Math.PI / 2; // flat on the ground
      glow.renderOrder = 3;
      glow.visible = false;
      this.group.add(glow);
      this.glows.push(glow);
      const row: Sprite[] = [];
      for (let j = 0; j < FLAMES_PER_POOL; j++) {
        const s = new Sprite(flameMat);
        s.visible = false;
        this.group.add(s);
        row.push(s);
      }
      this.flames.push(row);
    }
  }

  /** Position + flicker the glow disc and flame ring for each active fire pool (seated on `groundY`); hide the rest. */
  sync(pools: readonly Pool[], groundY: number, dtSeconds: number): void {
    this.clock += Math.max(0, dtSeconds);
    for (let i = 0; i < this.glows.length; i++) {
      const glow = this.glows[i]!;
      const row = this.flames[i]!;
      const p = pools[i];
      if (!p) {
        glow.visible = false;
        for (const s of row) s.visible = false;
        continue;
      }
      glow.visible = true;
      glow.position.set(p.x, groundY + 0.03, p.z);
      const tg = this.clock + i * 1.7;
      const pulse = 1 + 0.12 * Math.sin(tg * 5) + 0.06 * Math.sin(tg * 17);
      glow.scale.setScalar(p.radius * 1.15 * pulse);
      for (let j = 0; j < row.length; j++) {
        const s = row[j]!;
        s.visible = true;
        const off = unitOffset(i * 31 + j * 7 + 3);
        const ox = off.x * p.radius;
        const oz = off.z * p.radius;
        // flame height scales with the pool, taller toward the centre; per-flame two-rate flicker.
        const t = this.clock * 6 + (i * 4 + j) * 1.7;
        const base = (1 - off.r * 0.5) * Math.min(2.2, p.radius * 0.9 + 0.7);
        const h = base * (0.85 + 0.25 * Math.sin(t) + 0.12 * Math.sin(t * 3.3));
        const w = Math.max(0.35, h * 0.5);
        s.scale.set(w, Math.max(0.5, h), 1);
        s.position.set(p.x + ox, groundY + s.scale.y * 0.5, p.z + oz);
      }
    }
  }
}
