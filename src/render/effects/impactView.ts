// T80 / T81 — V57 surface-impact response. Shooting a WALL / structure (or a clean miss that stops on
// structure) used to read like blood beyond range, because the only marker was a reddish impact spark. This
// module gives the world a DISTINCT, clearly NON-RED structure response that can never be mistaken for gore:
//
//   (a) SPARK BURST  — a short-lived clutch of bright yellow-white instances thrown OUT of the struck surface
//                      (opposite the bullet's travel = along the surface normal, back toward the shooter),
//                      arcing under gravity + drag and fading fast.
//   (b) BULLET HOLE  — a small persistent DARK disc decal projected onto the struck surface, oriented to its
//                      normal, long-lived, recycled oldest-first by a ring buffer.
//   (c) WOUND        — a small DARK mark stamped at the struck region of a BODY (zombie OR player), oriented
//                      to face the shooter, accumulating + capped (T81).
//
// Blood is UNCHANGED and orthogonal: bloodSpray fires only on a real zombie damage-hit (bloodView). The wiring
// in GameViewport branches on the ShotResult so the wall response (spark + hole) NEVER fires on a body hit and
// the wound NEVER fires on a structure hit (see GameViewport).
//
// Pure-sim/thin-view split mirrors bloodView/gibView so the spawn + ageing logic is unit-tested without a GPU.
// Pooled + HARD-capped, no per-frame allocation (V24). Render-local RNG only (V2/V3). r184 binding-safe (V33):
// solid geometry + a PRE-CREATED instanceColor InstancedBufferAttribute. Decals follow the V56 depth policy:
// depthTest ON + depthWrite OFF + polygon-offset — NEVER depthTest:false.

import {
  InstancedMesh,
  IcosahedronGeometry,
  CircleGeometry,
  MeshBasicMaterial,
  AdditiveBlending,
  Object3D,
  Color,
  Vector3,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  type Scene,
} from 'three';
import type { AnatomyRegion, VisualEvent } from '../../game/core/contracts/events';
import type { BodyAnchorResolver } from './bloodView';
import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import { regionImpactHeight, type RegionHeights } from './combatFeedback';

// Bullet hole on structure: a dark, soot-edged puncture — clearly inert matter, distinct from any red gore.
const HOLE_COLOR = new Color(0.05, 0.05, 0.055);
// Wound on a body: a dark maroon mark (much darker than fresh blood spray so it reads as a torn entry wound,
// not a splatter). Still on the red axis but very dark — it sits ON the body, paired with the bright blood jet.
const WOUND_COLOR = new Color(0.14, 0.018, 0.018);

export interface ImpactSettings {
  readonly sparkPoolSize: number;
  readonly sparkCount: number;
  readonly sparkSizeMeters: number;
  readonly sparkLifeSeconds: number;
  readonly sparkSpeedMinMps: number;
  readonly sparkSpeedMaxMps: number;
  readonly sparkSpreadRad: number;
  readonly sparkGravityMps2: number;
  readonly sparkDragPerSecond: number;
  readonly sparkColor: { readonly r: number; readonly g: number; readonly b: number };
  readonly shardPoolSize: number;
  readonly shardCount: number;
  readonly shardSizeMeters: number;
  readonly shardLifeSeconds: number;
  readonly shardSpeedMinMps: number;
  readonly shardSpeedMaxMps: number;
  readonly shardSpreadRad: number;
  readonly shardGravityMps2: number;
  readonly shardSpinMaxRadPerSec: number;
  readonly shardColor: { readonly r: number; readonly g: number; readonly b: number };
  readonly holePoolSize: number;
  readonly holeSizeMeters: number;
  readonly holeLifeSeconds: number;
  readonly holeFadeFraction: number;
  readonly woundPoolSize: number;
  readonly woundSizeMeters: number;
  readonly woundLifeSeconds: number;
  readonly woundFadeFraction: number;
  readonly woundBodyRadiusMeters: number;
  readonly regionHeights: RegionHeights;
}

export function resolveImpactSettings(tier: QualityTier): ImpactSettings {
  return {
    sparkPoolSize: resolve(renderingConfig.impactSparkPoolSize, tier),
    sparkCount: resolve(renderingConfig.impactSparkCount, tier),
    sparkSizeMeters: resolve(renderingConfig.impactSparkSizeMeters, tier),
    sparkLifeSeconds: resolve(renderingConfig.impactSparkLifeSeconds, tier),
    sparkSpeedMinMps: resolve(renderingConfig.impactSparkSpeedMinMps, tier),
    sparkSpeedMaxMps: resolve(renderingConfig.impactSparkSpeedMaxMps, tier),
    sparkSpreadRad: resolve(renderingConfig.impactSparkSpreadRad, tier),
    sparkGravityMps2: resolve(renderingConfig.impactSparkGravityMps2, tier),
    sparkDragPerSecond: resolve(renderingConfig.impactSparkDragPerSecond, tier),
    sparkColor: {
      r: resolve(renderingConfig.impactSparkColorR, tier),
      g: resolve(renderingConfig.impactSparkColorG, tier),
      b: resolve(renderingConfig.impactSparkColorB, tier),
    },
    shardPoolSize: resolve(renderingConfig.impactShardPoolSize, tier),
    shardCount: resolve(renderingConfig.impactShardCount, tier),
    shardSizeMeters: resolve(renderingConfig.impactShardSizeMeters, tier),
    shardLifeSeconds: resolve(renderingConfig.impactShardLifeSeconds, tier),
    shardSpeedMinMps: resolve(renderingConfig.impactShardSpeedMinMps, tier),
    shardSpeedMaxMps: resolve(renderingConfig.impactShardSpeedMaxMps, tier),
    shardSpreadRad: resolve(renderingConfig.impactShardSpreadRad, tier),
    shardGravityMps2: resolve(renderingConfig.impactShardGravityMps2, tier),
    shardSpinMaxRadPerSec: resolve(renderingConfig.impactShardSpinMaxRadPerSec, tier),
    shardColor: {
      r: resolve(renderingConfig.impactShardColorR, tier),
      g: resolve(renderingConfig.impactShardColorG, tier),
      b: resolve(renderingConfig.impactShardColorB, tier),
    },
    holePoolSize: resolve(renderingConfig.impactHolePoolSize, tier),
    holeSizeMeters: resolve(renderingConfig.impactHoleSizeMeters, tier),
    holeLifeSeconds: resolve(renderingConfig.impactHoleLifeSeconds, tier),
    holeFadeFraction: resolve(renderingConfig.impactHoleFadeFraction, tier),
    woundPoolSize: resolve(renderingConfig.impactWoundPoolSize, tier),
    woundSizeMeters: resolve(renderingConfig.impactWoundSizeMeters, tier),
    woundLifeSeconds: resolve(renderingConfig.impactWoundLifeSeconds, tier),
    woundFadeFraction: resolve(renderingConfig.impactWoundFadeFraction, tier),
    woundBodyRadiusMeters: resolve(renderingConfig.impactWoundBodyRadiusMeters, tier),
    regionHeights: {
      head: resolve(renderingConfig.combatGoreHeightHeadMeters, tier),
      torso: resolve(renderingConfig.combatGoreHeightTorsoMeters, tier),
      leg: resolve(renderingConfig.combatGoreHeightLegMeters, tier),
    },
  };
}

/** Accessibility context for one impact (V29). goreIntensity 0 suppresses WOUNDS (gore); reduceFlashes thins +
 *  dims the bright SPARK burst (photosensitivity). Bullet HOLES are inert structure marks — never suppressed. */
export interface ImpactIngestContext {
  readonly goreIntensity: number;
  readonly reduceFlashes: boolean;
}

// Cheap render-local PRNG — VISUAL only, never touches sim/determinism (V2/V3).
let _seed = 0x2545f491 >>> 0;
function rnd(): number {
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 0xffffffff;
}

/**
 * Pure impact simulation (no GPU — unit-tested). Three pools:
 *   - sparks: compacted SoA (live entries [0,sparkCount)), swap-removed on expiry, hard-capped.
 *   - holes : ring buffer (persistent dark structure decals; oldest recycled past the cap).
 *   - wounds: ring buffer (dark body marks; oldest recycled past the cap).
 * The view reads the public SoA each frame to lay out the instanced batches; nothing here touches Three.js.
 */
export class ImpactSim {
  // --- spark SoA (compacted: live entries are [0, sCount)) ---
  readonly sx: Float32Array;
  readonly sy: Float32Array;
  readonly sz: Float32Array;
  readonly svx: Float32Array;
  readonly svy: Float32Array;
  readonly svz: Float32Array;
  readonly sSize: Float32Array;
  readonly sFade: Float32Array; // 0..1 brightness/visibility, recomputed each update (1 fresh -> 0 expired)
  private readonly sAge: Float32Array;
  private readonly sLife: Float32Array;
  private readonly sBright: Float32Array; // per-spark spawn brightness (reduce-flashes dims it)
  private sCount = 0;

  // --- glass-shard SoA (compacted: live entries are [0, gCount)) — pale tumbling debris off a smashed pane ---
  readonly gx: Float32Array;
  readonly gy: Float32Array;
  readonly gz: Float32Array;
  readonly gvx: Float32Array;
  readonly gvy: Float32Array;
  readonly gvz: Float32Array;
  readonly gSize: Float32Array;
  readonly gFade: Float32Array; // 0..1 visibility (1 fresh -> 0 expired); shards shrink as they fade
  readonly gax: Float32Array; // tumble axis (unit) x
  readonly gay: Float32Array; // tumble axis y
  readonly gaz: Float32Array; // tumble axis z
  readonly gAng: Float32Array; // current tumble angle (rad), advanced by gAngVel
  private readonly gAngVel: Float32Array;
  private readonly gAge: Float32Array;
  private readonly gLife: Float32Array;
  private gCount = 0;

  // --- bullet-hole SoA (ring buffer) ---
  readonly hx: Float32Array;
  readonly hy: Float32Array;
  readonly hz: Float32Array;
  readonly hnx: Float32Array; // surface normal the disc is oriented to
  readonly hny: Float32Array;
  readonly hnz: Float32Array;
  readonly hRot: Float32Array;
  readonly hVis: Float32Array; // 0..1 scale/visibility, recomputed each update
  private readonly hAge: Float32Array;
  private hHead = 0;
  private hCount = 0;

  // --- wound SoA (ring buffer) ---
  readonly wx: Float32Array;
  readonly wy: Float32Array;
  readonly wz: Float32Array;
  readonly wnx: Float32Array; // body-facing normal the disc is oriented to (toward the shooter)
  readonly wny: Float32Array;
  readonly wnz: Float32Array;
  readonly wRot: Float32Array;
  readonly wVis: Float32Array; // 0..1 scale/visibility, recomputed each update
  private readonly wAge: Float32Array;
  // Body-anchoring (T81 surface-stick): an entity-anchored wound stores a BODY-LOCAL offset + the struck
  // entity; update() reprojects it to the body's CURRENT transform each frame so the mark follows the moving
  // body (and the toppled corpse) instead of floating where it was hit. `wEntity < 0` = a static world wound.
  private readonly wEntity: Float32Array;
  private readonly wLX: Float32Array;
  private readonly wLY: Float32Array;
  private readonly wLZ: Float32Array;
  private woundAnchors: BodyAnchorResolver | null = null;
  private wHead = 0;
  private wCount = 0;

  // scratch basis vectors for the spark cone (no per-spawn allocation)
  private readonly _t = new Vector3();
  private readonly _b = new Vector3();
  private readonly _n = new Vector3();

  constructor(readonly settings: ImpactSettings) {
    const S = Math.max(1, settings.sparkPoolSize);
    this.sx = new Float32Array(S);
    this.sy = new Float32Array(S);
    this.sz = new Float32Array(S);
    this.svx = new Float32Array(S);
    this.svy = new Float32Array(S);
    this.svz = new Float32Array(S);
    this.sSize = new Float32Array(S);
    this.sFade = new Float32Array(S);
    this.sAge = new Float32Array(S);
    this.sLife = new Float32Array(S);
    this.sBright = new Float32Array(S);
    const G = Math.max(1, settings.shardPoolSize);
    this.gx = new Float32Array(G);
    this.gy = new Float32Array(G);
    this.gz = new Float32Array(G);
    this.gvx = new Float32Array(G);
    this.gvy = new Float32Array(G);
    this.gvz = new Float32Array(G);
    this.gSize = new Float32Array(G);
    this.gFade = new Float32Array(G);
    this.gax = new Float32Array(G);
    this.gay = new Float32Array(G);
    this.gaz = new Float32Array(G);
    this.gAng = new Float32Array(G);
    this.gAngVel = new Float32Array(G);
    this.gAge = new Float32Array(G);
    this.gLife = new Float32Array(G);
    const H = Math.max(1, settings.holePoolSize);
    this.hx = new Float32Array(H);
    this.hy = new Float32Array(H);
    this.hz = new Float32Array(H);
    this.hnx = new Float32Array(H);
    this.hny = new Float32Array(H);
    this.hnz = new Float32Array(H);
    this.hRot = new Float32Array(H);
    this.hVis = new Float32Array(H);
    this.hAge = new Float32Array(H);
    const W = Math.max(1, settings.woundPoolSize);
    this.wx = new Float32Array(W);
    this.wy = new Float32Array(W);
    this.wz = new Float32Array(W);
    this.wnx = new Float32Array(W);
    this.wny = new Float32Array(W);
    this.wnz = new Float32Array(W);
    this.wRot = new Float32Array(W);
    this.wVis = new Float32Array(W);
    this.wAge = new Float32Array(W);
    this.wEntity = new Float32Array(W).fill(-1); // -1 = static/world wound (not body-anchored)
    this.wLX = new Float32Array(W);
    this.wLY = new Float32Array(W);
    this.wLZ = new Float32Array(W);
  }

  /** Inject the body-anchor resolver (T81 surface-stick) so entity-anchored wounds follow the struck body +
   *  its toppled corpse. Until set (null), `woundOnBody` falls back to a static world mark at the body point. */
  setBodyAnchors(resolver: BodyAnchorResolver | null): void {
    this.woundAnchors = resolver;
  }

  get sparkCount(): number {
    return this.sCount;
  }
  get shardCount(): number {
    return this.gCount;
  }
  get holeCount(): number {
    return this.hCount;
  }
  get woundCount(): number {
    return this.wCount;
  }

  /**
   * STRUCTURE hit (T80): a clean miss / shot that stopped on a wall. Stamps a persistent bullet HOLE at the
   * struck surface point oriented to its normal, and throws a bright SPARK burst OUT of the surface (along the
   * normal = opposite the bullet's inward travel). (nx,ny,nz) is the world-space surface normal pointing back
   * toward the shooter. NOT gore — bullet holes are inert and always shown; reduceFlashes thins/dims sparks.
   */
  structureImpact(x: number, y: number, z: number, nx: number, ny: number, nz: number, ctx: ImpactIngestContext): void {
    const nlen = Math.hypot(nx, ny, nz);
    if (nlen < 1e-6) return;
    const ux = nx / nlen;
    const uy = ny / nlen;
    const uz = nz / nlen;
    this.addHole(x, y, z, ux, uy, uz);
    this.burstSparks(x, y, z, ux, uy, uz, ctx);
  }

  /**
   * BODY hit (T81): stamp a dark WOUND mark at the struck region of a body. `baseY` is the body base (ground);
   * the region->height map lifts it to the struck band. (faceX,faceZ) points back toward the shooter so the
   * disc faces the camera/shooter. Gore — suppressed when goreIntensity <= 0 (V29).
   */
  wound(x: number, baseY: number, z: number, region: AnatomyRegion, faceX: number, faceZ: number, ctx: ImpactIngestContext): void {
    if (ctx.goreIntensity <= 0 || this.wx.length === 0) return;
    const flen = Math.hypot(faceX, faceZ);
    const fnx = flen > 1e-6 ? faceX / flen : 0;
    const fnz = flen > 1e-6 ? faceZ / flen : 1;
    const wy = baseY + regionImpactHeight(region, this.settings.regionHeights);
    const i = this.wHead;
    this.wHead = (this.wHead + 1) % this.wx.length; // ring buffer — oldest recycled (V24)
    if (this.wCount < this.wx.length) this.wCount++;
    this.wx[i] = x;
    this.wy[i] = wy;
    this.wz[i] = z;
    this.wnx[i] = fnx;
    this.wny[i] = 0;
    this.wnz[i] = fnz;
    this.wRot[i] = rnd() * Math.PI * 2;
    this.wVis[i] = 1;
    this.wAge[i] = 0;
    this.wEntity[i] = -1; // static world wound (a recycled slot may have been anchored — reset it)
  }

  /**
   * BODY hit, ANCHORED (T81 surface-stick): a dark wound that STICKS to the struck body `entity`. Placed on the
   * region-height band, offset onto the body surface toward the shooter by a body-hugging radius, then
   * reprojected to the body's live transform every frame (update) so it follows the moving body + its toppled
   * corpse instead of floating where the shot landed. No-op if goreIntensity 0 (V29) or the body is unknown/gone.
   */
  woundOnBody(entity: number, region: AnatomyRegion, faceX: number, faceZ: number, ctx: ImpactIngestContext): void {
    if (ctx.goreIntensity <= 0 || this.wx.length === 0) return;
    const a = this.woundAnchors ? this.woundAnchors.resolve(entity) : null;
    if (!a) return; // no resolver wired or the body already vanished — nothing to mark
    const flen = Math.hypot(faceX, faceZ);
    const fnx = flen > 1e-6 ? faceX / flen : 0;
    const fnz = flen > 1e-6 ? faceZ / flen : 1;
    const r = this.settings.woundBodyRadiusMeters;
    const i = this.wHead;
    this.wHead = (this.wHead + 1) % this.wx.length; // ring buffer — oldest recycled (V24)
    if (this.wCount < this.wx.length) this.wCount++;
    this.wnx[i] = fnx;
    this.wny[i] = 0;
    this.wnz[i] = fnz;
    this.wRot[i] = rnd() * Math.PI * 2;
    this.wVis[i] = 1;
    this.wAge[i] = 0;
    this.wEntity[i] = entity;
    this.wLX[i] = fnx * r; // surface offset toward the shooter (hugs the limb)
    this.wLY[i] = regionImpactHeight(region, this.settings.regionHeights);
    this.wLZ[i] = fnz * r;
    this.reprojectWound(i); // seed the world position now
  }

  /** Reproject an entity-anchored wound to the struck body's CURRENT transform (T81), lerping toward the
   *  toppled-corpse placement by `lying` so it rides the body to the floor. Static (wEntity<0) wounds and
   *  vanished bodies (resolve→null) are left where they are (the latter then fades out by age). */
  private reprojectWound(i: number): void {
    const e = this.wEntity[i]!;
    if (e < 0) return;
    const a = this.woundAnchors ? this.woundAnchors.resolve(e) : null;
    if (!a) return;
    const lx = this.wLX[i]!;
    const ly = this.wLY[i]!;
    const lz = this.wLZ[i]!;
    const ux = a.x + lx;
    const uy = a.y + ly;
    const uz = a.z + lz;
    const ch = Math.cos(a.heading);
    const sh = Math.sin(a.heading);
    const tx = a.x + ch * ly - sh * lx;
    const ty = a.groundY;
    const tz = a.z + sh * ly + ch * lx;
    const t = a.lying < 0 ? 0 : a.lying > 1 ? 1 : a.lying;
    this.wx[i] = ux + (tx - ux) * t;
    this.wy[i] = uy + (ty - uy) * t;
    this.wz[i] = uz + (tz - uz) * t;
  }

  private addHole(x: number, y: number, z: number, ux: number, uy: number, uz: number): void {
    if (this.hx.length === 0) return;
    const i = this.hHead;
    this.hHead = (this.hHead + 1) % this.hx.length; // ring buffer — oldest recycled (V24)
    if (this.hCount < this.hx.length) this.hCount++;
    this.hx[i] = x;
    this.hy[i] = y;
    this.hz[i] = z;
    this.hnx[i] = ux;
    this.hny[i] = uy;
    this.hnz[i] = uz;
    this.hRot[i] = rnd() * Math.PI * 2;
    this.hVis[i] = 1;
    this.hAge[i] = 0;
  }

  /** Throw the spark clutch along the +normal within a cone, biased by speed. Compacted pool, hard-capped (V24). */
  private burstSparks(x: number, y: number, z: number, ux: number, uy: number, uz: number, ctx: ImpactIngestContext): void {
    const s = this.settings;
    let n = s.sparkCount;
    if (ctx.reduceFlashes) n = Math.max(1, Math.round(n * 0.5)); // V29 — thin the flash
    const bright = ctx.reduceFlashes ? 0.5 : 1; // V29 — dim the flash for photosensitivity
    // Build an orthonormal basis (t,b) spanning the plane perpendicular to the normal so the cone scatters
    // evenly around it. Pick the world axis least aligned with the normal to avoid a degenerate cross.
    this._n.set(ux, uy, uz);
    if (Math.abs(uy) < 0.99) this._t.set(0, 1, 0);
    else this._t.set(1, 0, 0);
    this._t.cross(this._n).normalize();
    this._b.copy(this._n).cross(this._t).normalize();
    for (let k = 0; k < n; k++) {
      if (this.sCount >= this.sx.length) break; // hard cap (V24) — never grows.
      const i = this.sCount++;
      const theta = rnd() * s.sparkSpreadRad; // angle off the normal
      const phi = rnd() * Math.PI * 2; // around the normal
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      // direction = n*cos(theta) + (t*cos(phi)+b*sin(phi))*sin(theta) — a unit vector inside the cone.
      const dx = ux * ct + (this._t.x * cp + this._b.x * sp) * st;
      const dy = uy * ct + (this._t.y * cp + this._b.y * sp) * st;
      const dz = uz * ct + (this._t.z * cp + this._b.z * sp) * st;
      const speed = s.sparkSpeedMinMps + rnd() * (s.sparkSpeedMaxMps - s.sparkSpeedMinMps);
      this.sx[i] = x;
      this.sy[i] = y;
      this.sz[i] = z;
      this.svx[i] = dx * speed;
      this.svy[i] = dy * speed;
      this.svz[i] = dz * speed;
      this.sSize[i] = s.sparkSizeMeters * (0.5 + rnd() * 0.8);
      this.sAge[i] = 0;
      this.sLife[i] = s.sparkLifeSeconds * (0.6 + rnd() * 0.6); // stagger so the clutch doesn't vanish in lockstep
      this.sBright[i] = bright;
      this.sFade[i] = bright;
    }
  }

  /**
   * GLASS SHATTER (T108): a window pane breaking. Throws a clutch of pale faceted shards OUT of the pane
   * within a cone around the wall normal (nx,ny,nz — pointing off the pane toward the smasher), each with a
   * random tumble axis + spin. Shards arc under gravity and shrink away (no additive flash — glass, not spark).
   * reduceFlashes thins the clutch (V29). Compacted pool, hard-capped (V24). Pure (no GPU / no sim coupling).
   */
  glassShatter(x: number, y: number, z: number, nx: number, ny: number, nz: number, ctx: ImpactIngestContext): void {
    const s = this.settings;
    const nlen = Math.hypot(nx, ny, nz);
    if (nlen < 1e-6) return;
    const ux = nx / nlen;
    const uy = ny / nlen;
    const uz = nz / nlen;
    let n = s.shardCount;
    if (ctx.reduceFlashes) n = Math.max(1, Math.round(n * 0.6)); // V29 — thin the burst (less visual churn)
    // Orthonormal basis (t,b) spanning the plane perpendicular to the normal so the cone scatters evenly.
    this._n.set(ux, uy, uz);
    if (Math.abs(uy) < 0.99) this._t.set(0, 1, 0);
    else this._t.set(1, 0, 0);
    this._t.cross(this._n).normalize();
    this._b.copy(this._n).cross(this._t).normalize();
    for (let k = 0; k < n; k++) {
      if (this.gCount >= this.gx.length) break; // hard cap (V24)
      const i = this.gCount++;
      const theta = rnd() * s.shardSpreadRad;
      const phi = rnd() * Math.PI * 2;
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      const dx = ux * ct + (this._t.x * cp + this._b.x * sp) * st;
      const dy = uy * ct + (this._t.y * cp + this._b.y * sp) * st;
      const dz = uz * ct + (this._t.z * cp + this._b.z * sp) * st;
      const speed = s.shardSpeedMinMps + rnd() * (s.shardSpeedMaxMps - s.shardSpeedMinMps);
      this.gx[i] = x;
      this.gy[i] = y;
      this.gz[i] = z;
      this.gvx[i] = dx * speed;
      this.gvy[i] = dy * speed + rnd() * 0.6; // slight upward kick so some shards arc before falling
      this.gvz[i] = dz * speed;
      this.gSize[i] = s.shardSizeMeters * (0.5 + rnd() * 1.0);
      this.gAge[i] = 0;
      this.gLife[i] = s.shardLifeSeconds * (0.6 + rnd() * 0.8);
      this.gFade[i] = 1;
      // random tumble axis (unit) + spin speed
      let axx = rnd() * 2 - 1;
      let axy = rnd() * 2 - 1;
      let axz = rnd() * 2 - 1;
      const al = Math.hypot(axx, axy, axz) || 1;
      axx /= al; axy /= al; axz /= al;
      this.gax[i] = axx;
      this.gay[i] = axy;
      this.gaz[i] = axz;
      this.gAng[i] = rnd() * Math.PI * 2;
      this.gAngVel[i] = (rnd() * 2 - 1) * s.shardSpinMaxRadPerSec;
    }
  }

  private moveShard(from: number, to: number): void {
    this.gx[to] = this.gx[from]!;
    this.gy[to] = this.gy[from]!;
    this.gz[to] = this.gz[from]!;
    this.gvx[to] = this.gvx[from]!;
    this.gvy[to] = this.gvy[from]!;
    this.gvz[to] = this.gvz[from]!;
    this.gSize[to] = this.gSize[from]!;
    this.gFade[to] = this.gFade[from]!;
    this.gax[to] = this.gax[from]!;
    this.gay[to] = this.gay[from]!;
    this.gaz[to] = this.gaz[from]!;
    this.gAng[to] = this.gAng[from]!;
    this.gAngVel[to] = this.gAngVel[from]!;
    this.gAge[to] = this.gAge[from]!;
    this.gLife[to] = this.gLife[from]!;
  }

  update(dt: number): void {
    if (dt < 0) throw new Error(`dt must be non-negative, got ${dt}`);
    const s = this.settings;
    const drag = Math.max(0, 1 - s.sparkDragPerSecond * dt);
    // Sparks: integrate (gravity + drag), age, fade; swap-remove on expiry (compacted pool).
    for (let i = this.sCount - 1; i >= 0; i--) {
      this.sAge[i]! += dt;
      if (this.sAge[i]! >= this.sLife[i]!) {
        const last = --this.sCount;
        if (i !== last) this.moveSpark(last, i);
        continue;
      }
      this.svy[i]! -= s.sparkGravityMps2 * dt;
      this.svx[i]! *= drag;
      this.svy[i]! *= drag;
      this.svz[i]! *= drag;
      this.sx[i]! += this.svx[i]! * dt;
      this.sy[i]! += this.svy[i]! * dt;
      this.sz[i]! += this.svz[i]! * dt;
      // Fade brightness fast over the spark life (quadratic for a hot-then-gone flash).
      const t = this.sAge[i]! / this.sLife[i]!;
      this.sFade[i] = this.sBright[i]! * (1 - t) * (1 - t);
    }
    // Glass shards: integrate (gravity, no drag — glass keeps momentum), tumble, age, shrink-fade; swap-remove.
    for (let i = this.gCount - 1; i >= 0; i--) {
      this.gAge[i]! += dt;
      if (this.gAge[i]! >= this.gLife[i]!) {
        const last = --this.gCount;
        if (i !== last) this.moveShard(last, i);
        continue;
      }
      this.gvy[i]! -= s.shardGravityMps2 * dt;
      this.gx[i]! += this.gvx[i]! * dt;
      this.gy[i]! += this.gvy[i]! * dt;
      this.gz[i]! += this.gvz[i]! * dt;
      this.gAng[i]! += this.gAngVel[i]! * dt;
      // Hold full size, then shrink/fade the final third of life (a shard winking out, not popping).
      const t = this.gAge[i]! / this.gLife[i]!;
      this.gFade[i] = t < 0.66 ? 1 : Math.max(0, (1 - t) / 0.34);
    }

    // Bullet holes: persist at full size, then a gentle end-of-life shrink/fade before the ring buffer recycles.
    ageDecals(this.hAge, this.hVis, this.hCount, dt, s.holeLifeSeconds, s.holeFadeFraction);
    // Wounds: reproject the body-anchored ones to the struck body's live transform (T81 — so they ride the
    // moving body + corpse, never floating where the shot landed), THEN age/fade by their lifetime profile.
    for (let i = 0; i < this.wCount; i++) this.reprojectWound(i);
    ageDecals(this.wAge, this.wVis, this.wCount, dt, s.woundLifeSeconds, s.woundFadeFraction);
  }

  private moveSpark(from: number, to: number): void {
    this.sx[to] = this.sx[from]!;
    this.sy[to] = this.sy[from]!;
    this.sz[to] = this.sz[from]!;
    this.svx[to] = this.svx[from]!;
    this.svy[to] = this.svy[from]!;
    this.svz[to] = this.svz[from]!;
    this.sSize[to] = this.sSize[from]!;
    this.sFade[to] = this.sFade[from]!;
    this.sAge[to] = this.sAge[from]!;
    this.sLife[to] = this.sLife[from]!;
    this.sBright[to] = this.sBright[from]!;
  }
}

/** Age a ring-buffer decal pool in place: hold full visibility, then linearly fade the final fadeFraction of
 *  the lifetime to 0. Expired entries collapse to 0 visibility until the ring buffer reuses the slot (V24). */
function ageDecals(age: Float32Array, vis: Float32Array, count: number, dt: number, life: number, fadeFraction: number): void {
  const fadeStart = life * (1 - fadeFraction);
  for (let i = 0; i < count; i++) {
    age[i]! += dt;
    const a = age[i]!;
    if (a >= life) {
      vis[i] = 0;
    } else if (a > fadeStart) {
      vis[i] = Math.max(0, (life - a) / (life * fadeFraction));
    } else {
      vis[i] = 1;
    }
  }
}

const DECAL_DEFAULT_NORMAL = new Vector3(0, 0, 1); // CircleGeometry faces +Z before orientation
const DECAL_SURFACE_OFFSET = 0.02; // m — lift the decal a hair off the surface along its normal (no z-fight)

/**
 * Thin GPU view: owns three InstancedMeshes (sparks + bullet holes + wounds) and mirrors the pure ImpactSim
 * state onto them each frame. r184 binding-safe — solid geometry + a PRE-CREATED instanceColor (V33). Sparks
 * are an ADDITIVE bright bead; decals follow the V56 depth policy (depthTest ON, depthWrite OFF, polygon-offset).
 * Every resource is tracked for disposal (V24).
 */
export class ImpactView {
  readonly sim: ImpactSim;
  private readonly sparkMesh: InstancedMesh;
  private readonly shardMesh: InstancedMesh;
  private readonly holeMesh: InstancedMesh;
  private readonly woundMesh: InstancedMesh;
  private readonly shardColor: Color;
  private readonly dummy = new Object3D();
  private readonly tmp = new Color();
  private readonly normalScratch = new Vector3();

  constructor(settings: ImpactSettings, registry: ResourceRegistry) {
    this.sim = new ImpactSim(settings);

    // ---- sparks: tiny faceted bright bead, additive so the burst pops as a hot flash (non-red) ----
    const sparkGeo = registry.track(new IcosahedronGeometry(1, 0), 'geometry', 'impact.sparkGeo');
    const sparkMat = registry.track(
      new MeshBasicMaterial({ name: 'impact.spark', toneMapped: false, transparent: true, blending: AdditiveBlending, depthWrite: false }),
      'material',
      'impact.sparkMat',
    );
    this.sparkMesh = registry.track(new InstancedMesh(sparkGeo, sparkMat, Math.max(1, settings.sparkPoolSize)), 'buffer', 'impact.sparkMesh');
    primeInstanced(this.sparkMesh);
    this.sparkMesh.renderOrder = 3;

    // ---- glass shards: pale faceted chip, transparent (NOT additive — glass, not a hot flash). Tumbles + falls. ----
    this.shardColor = new Color(settings.shardColor.r, settings.shardColor.g, settings.shardColor.b);
    const shardGeo = registry.track(new IcosahedronGeometry(1, 0), 'geometry', 'impact.shardGeo');
    const shardMat = registry.track(
      new MeshBasicMaterial({ name: 'impact.shard', transparent: true, opacity: 0.78, depthWrite: false }),
      'material',
      'impact.shardMat',
    );
    this.shardMesh = registry.track(new InstancedMesh(shardGeo, shardMat, Math.max(1, settings.shardPoolSize)), 'buffer', 'impact.shardMesh');
    primeInstanced(this.shardMesh);
    this.shardMesh.renderOrder = 3;

    // ---- bullet holes: dark disc projected on the surface. V56 depth policy. ----
    const holeGeo = registry.track(new CircleGeometry(0.5, 16), 'geometry', 'impact.holeGeo');
    const holeMat = registry.track(
      new MeshBasicMaterial({
        name: 'impact.hole',
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
      'material',
      'impact.holeMat',
    );
    this.holeMesh = registry.track(new InstancedMesh(holeGeo, holeMat, Math.max(1, settings.holePoolSize)), 'buffer', 'impact.holeMesh');
    primeInstanced(this.holeMesh);
    this.holeMesh.renderOrder = 1;

    // ---- wounds: dark maroon mark on the body. V56 depth policy. ----
    const woundGeo = registry.track(new CircleGeometry(0.5, 16), 'geometry', 'impact.woundGeo');
    const woundMat = registry.track(
      new MeshBasicMaterial({
        name: 'impact.wound',
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
      'material',
      'impact.woundMat',
    );
    this.woundMesh = registry.track(new InstancedMesh(woundGeo, woundMat, Math.max(1, settings.woundPoolSize)), 'buffer', 'impact.woundMesh');
    primeInstanced(this.woundMesh);
    this.woundMesh.renderOrder = 2;
  }

  /** Add the impact meshes to the scene graph (parent owns graph membership; registry owns disposal). */
  attachTo(scene: Scene | Object3D): void {
    scene.add(this.sparkMesh, this.shardMesh, this.holeMesh, this.woundMesh);
  }

  /** STRUCTURE hit — bullet hole + spark burst (T80). */
  structureImpact(x: number, y: number, z: number, nx: number, ny: number, nz: number, ctx: ImpactIngestContext): void {
    this.sim.structureImpact(x, y, z, nx, ny, nz, ctx);
  }

  /** GLASS SHATTER (T108) — a window pane breaking throws a pale tumbling shard burst off the pane normal. */
  glassShatter(x: number, y: number, z: number, nx: number, ny: number, nz: number, ctx: ImpactIngestContext): void {
    this.sim.glassShatter(x, y, z, nx, ny, nz, ctx);
  }

  /** Drain glassShatter VISUAL events from the sim stream into shard bursts (T108). Mirrors blood/gibView.consume:
   *  a pure read of the drained stream (V2) — every window smash (verb / shot / zombie attrition) lands here. */
  consume(visual: readonly VisualEvent[], ctx: ImpactIngestContext): void {
    for (const e of visual) {
      if (e.kind === 'glassShatter') this.sim.glassShatter(e.x, e.y, e.z, e.nx, 0, e.nz, ctx);
    }
  }

  /** BODY hit — dark wound mark (T81), static world placement. */
  wound(x: number, baseY: number, z: number, region: AnatomyRegion, faceX: number, faceZ: number, ctx: ImpactIngestContext): void {
    this.sim.wound(x, baseY, z, region, faceX, faceZ, ctx);
  }

  /** BODY hit — dark wound that STICKS to the struck body + follows it (T81 surface-stick). */
  woundOnBody(entity: number, region: AnatomyRegion, faceX: number, faceZ: number, ctx: ImpactIngestContext): void {
    this.sim.woundOnBody(entity, region, faceX, faceZ, ctx);
  }

  /** Inject the body-anchor resolver so body wounds follow the struck body + corpse (T81). */
  setBodyAnchors(resolver: BodyAnchorResolver | null): void {
    this.sim.setBodyAnchors(resolver);
  }

  /** Advance the sim then mirror its SoA onto the instanced batches. */
  update(dt: number): void {
    this.sim.update(dt);
    const sim = this.sim;
    const sparkColor = sim.settings.sparkColor;

    // ---- sparks ----
    const ns = sim.sparkCount;
    for (let i = 0; i < ns; i++) {
      const f = sim.sFade[i]!;
      this.dummy.position.set(sim.sx[i]!, sim.sy[i]!, sim.sz[i]!);
      this.dummy.quaternion.identity();
      this.dummy.scale.setScalar(sim.sSize[i]! * Math.max(0.0001, f)); // shrink as it fades
      this.dummy.updateMatrix();
      this.sparkMesh.setMatrixAt(i, this.dummy.matrix);
      this.sparkMesh.setColorAt(i, this.tmp.setRGB(sparkColor.r * f, sparkColor.g * f, sparkColor.b * f));
    }
    this.sparkMesh.count = ns;
    this.sparkMesh.instanceMatrix.needsUpdate = true;
    if (this.sparkMesh.instanceColor) this.sparkMesh.instanceColor.needsUpdate = true;

    // ---- glass shards: position + tumble (axis-angle) + shrink as it fades ----
    const ng = sim.shardCount;
    for (let i = 0; i < ng; i++) {
      const f = sim.gFade[i]!;
      this.dummy.position.set(sim.gx[i]!, sim.gy[i]!, sim.gz[i]!);
      this.dummy.quaternion.setFromAxisAngle(this.normalScratch.set(sim.gax[i]!, sim.gay[i]!, sim.gaz[i]!), sim.gAng[i]!);
      this.dummy.scale.setScalar(sim.gSize[i]! * Math.max(0.0001, f));
      this.dummy.updateMatrix();
      this.shardMesh.setMatrixAt(i, this.dummy.matrix);
      this.shardMesh.setColorAt(i, this.tmp.setRGB(this.shardColor.r, this.shardColor.g, this.shardColor.b));
    }
    this.shardMesh.count = ng;
    this.shardMesh.instanceMatrix.needsUpdate = true;
    if (this.shardMesh.instanceColor) this.shardMesh.instanceColor.needsUpdate = true;

    // ---- bullet holes ----
    const nh = sim.holeCount;
    for (let i = 0; i < nh; i++) {
      const vis = sim.hVis[i]!;
      this.orientDecal(this.holeMesh, i, sim.hx[i]!, sim.hy[i]!, sim.hz[i]!, sim.hnx[i]!, sim.hny[i]!, sim.hnz[i]!, sim.hRot[i]!, sim.settings.holeSizeMeters * vis);
      this.holeMesh.setColorAt(i, this.tmp.setRGB(HOLE_COLOR.r, HOLE_COLOR.g, HOLE_COLOR.b));
    }
    this.holeMesh.count = nh;
    this.holeMesh.instanceMatrix.needsUpdate = true;
    if (this.holeMesh.instanceColor) this.holeMesh.instanceColor.needsUpdate = true;

    // ---- wounds ----
    const nw = sim.woundCount;
    for (let i = 0; i < nw; i++) {
      const vis = sim.wVis[i]!;
      this.orientDecal(this.woundMesh, i, sim.wx[i]!, sim.wy[i]!, sim.wz[i]!, sim.wnx[i]!, sim.wny[i]!, sim.wnz[i]!, sim.wRot[i]!, sim.settings.woundSizeMeters * vis);
      this.woundMesh.setColorAt(i, this.tmp.setRGB(WOUND_COLOR.r, WOUND_COLOR.g, WOUND_COLOR.b));
    }
    this.woundMesh.count = nw;
    this.woundMesh.instanceMatrix.needsUpdate = true;
    if (this.woundMesh.instanceColor) this.woundMesh.instanceColor.needsUpdate = true;
  }

  /** Orient one decal instance to its surface normal, lift it a hair off the surface, spin in-plane, scale. */
  private orientDecal(mesh: InstancedMesh, i: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, rot: number, diameter: number): void {
    this.normalScratch.set(nx, ny, nz);
    this.dummy.position.set(x + nx * DECAL_SURFACE_OFFSET, y + ny * DECAL_SURFACE_OFFSET, z + nz * DECAL_SURFACE_OFFSET);
    this.dummy.quaternion.setFromUnitVectors(DECAL_DEFAULT_NORMAL, this.normalScratch);
    this.dummy.rotateZ(rot);
    this.dummy.scale.set(Math.max(0.0001, diameter), Math.max(0.0001, diameter), 1);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(i, this.dummy.matrix);
  }
}

/** r184 binding-safe instanced prep: pre-create the instanceColor attribute, dynamic usage, no culling. */
function primeInstanced(mesh: InstancedMesh): void {
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  const buf = new Float32Array(mesh.count * 3).fill(1);
  mesh.instanceColor = new InstancedBufferAttribute(buf, 3);
  mesh.instanceColor.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
}
