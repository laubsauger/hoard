// T75 / V51 — pooled BLOOD system. Supersedes the basic combat-feedback blood spray (combatFeedback.ts):
// biological hits throw pooled directional droplets that arc under gravity + air drag and LAND as drying
// DIRECTIONAL floor decals (lobed, lopsided blobs — not perfect ellipses). A freshly blood-soaked player
// who keeps moving leaves bloody footprints. Pure-view (V2): driven by the drained VisualEvent stream,
// never feeds the sim back. Pooled + HARD-capped, no per-frame allocation (V24).
//
// Adapts the proven mars-inc blood-view technique to OUR contracts: hitReaction carries the impact
// direction/energy/struck REGION (no position), the paired bloodSpray carries the world position — we pair
// them in emission order (mirroring combatFeedback) to spawn a positioned, region-height, energy-weighted
// directional jet. partDetached throws extra blood at the last impact (the gib chunk itself is GibView).
//
// r184 binding-safe (V33): solid SphereGeometry / lobed CircleGeometry + a PRE-CREATED instanceColor
// InstancedBufferAttribute; MeshBasicMaterial{toneMapped:false} so blood reads as matter, not a glow. No
// lazy setColorAt on a mesh without a pre-allocated instanceColor.
//
// DEFERRED (needs T70 player mesh in blockScene + a positioned death VisualEvent — not ours to add): the
// death-clutch gib burst and the player-BODY gore coating that parents to the player mesh. The footstep
// system here is a lightweight stand-in driven by a tracked "wetness" accumulator from nearby blood, not by
// an actual body-gore layer. Tie T54/T55.

import {
  InstancedMesh,
  SphereGeometry,
  CircleGeometry,
  MeshBasicMaterial,
  Object3D,
  Color,
  Vector3,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  type Scene,
} from 'three';
import type { AnatomyRegion, VisualEvent } from '../../game/core/contracts/events';
import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import { regionImpactHeight, type RegionHeights } from './combatFeedback';

/** Gore palette key. Only `blood` is emitted today (our VisualEvent carries no archetype); ichor/burned are
 *  structured in so they plug in unchanged once an archetype rides the event (noted in the report). */
export type GoreType = 'blood' | 'ichor' | 'burned';

// Fresh airborne blood — darker than the bright HUD accents so it reads as matter, not a glow.
const BLOOD = new Color(0.46, 0.02, 0.02);
const ICHOR = new Color(0.2, 0.34, 0.04); // dark olive — distinct from green XP/pickups
const BURNED = new Color(0.12, 0.1, 0.1); // charred — placeholder for a burned archetype
// A settled decal first DARKENS to this dried-blood colour (dark maroon — still clearly red matter, NOT
// the floor shadow) and lingers there for the long dried phase (T77/V54).
const DRY_TARGET = new Color(0.16, 0.03, 0.02);
// At the very end of its life it fades the last step into the floor shadow so recycling never pops.
const FLOOR_FADE = new Color(0.05, 0.025, 0.02);

export function goreColor(kind: GoreType): Color {
  return kind === 'ichor' ? ICHOR : kind === 'burned' ? BURNED : BLOOD;
}

/** A surface the render-side raycast found (world point + unit normal). Floor → normal ≈ +Y; wall → horizontal. */
export interface SurfaceHit {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/**
 * Render-side, READ-ONLY surface projector (T77/V54). Lets the pure BloodSim place decals on the REAL scene
 * structure — the true floor/slab height (interior floors sit above the street) and walls behind a struck
 * body — without the sim knowing about Three.js. The concrete impl (RaycastSurfaceProjector) wraps a
 * THREE.Raycaster over the static structure meshes; unit tests inject a mock. Raycasts are bounded: at most
 * one floor + one wall cast per blood-spray event (never per droplet per frame).
 */
export interface SurfaceProjector {
  /** Nearest structure surface directly below (x,z) cast DOWN from `fromY` (the impact height, below the
   *  roof): its world Y + normal. Casting from the impact height — not the sky — finds the floor/slab the
   *  body stands on rather than the roof above it. null when nothing is below. */
  floorBelow(x: number, fromY: number, z: number): SurfaceHit | null;
  /** Nearest structure surface from (x,y,z) along the horizontal (dirX,dirZ) within maxDist — a wall splat target. */
  wallAlong(x: number, y: number, z: number, dirX: number, dirZ: number, maxDist: number): SurfaceHit | null;
}

export interface BloodSettings {
  readonly dropletPoolSize: number;
  readonly decalPoolSize: number;
  readonly gravityMps2: number;
  readonly airDragPerSecond: number;
  readonly floorYMeters: number;
  readonly decalLifeSeconds: number;
  readonly decalFreshSeconds: number;
  readonly decalDryTransitionSeconds: number;
  readonly decalFadeFraction: number;
  readonly decalStainChance: number;
  readonly wallSplatReachMeters: number;
  readonly wallSplatCount: number;
  readonly decalDimFactor: number;
  readonly dropletsPerHit: number;
  readonly severExtraDroplets: number;
  readonly dropletSpeedMinMps: number;
  readonly dropletSpeedMaxMps: number;
  readonly dropletUpwardMps: number;
  readonly spreadRad: number;
  readonly critSpreadRad: number;
  readonly dropletSizeMeters: number;
  readonly distantSimplifyMeters: number;
  readonly distantCountScale: number;
  readonly footstepCadenceSeconds: number;
  readonly footstepStrideOffsetMeters: number;
  readonly footstepPrintSizeMeters: number;
  readonly footstepRangeMeters: number;
  readonly footstepWetnessGainPerHit: number;
  readonly footstepWetnessDecayPerSecond: number;
  readonly footstepWetnessThreshold: number;
  readonly regionHeights: RegionHeights;
}

export function resolveBloodSettings(tier: QualityTier): BloodSettings {
  return {
    dropletPoolSize: resolve(renderingConfig.bloodDropletPoolSize, tier),
    decalPoolSize: resolve(renderingConfig.bloodDecalPoolSize, tier),
    gravityMps2: resolve(renderingConfig.bloodGravityMps2, tier),
    airDragPerSecond: resolve(renderingConfig.bloodAirDragPerSecond, tier),
    floorYMeters: resolve(renderingConfig.bloodFloorYMeters, tier),
    decalLifeSeconds: resolve(renderingConfig.bloodDecalLifeSeconds, tier),
    decalFreshSeconds: resolve(renderingConfig.bloodDecalFreshSeconds, tier),
    decalDryTransitionSeconds: resolve(renderingConfig.bloodDecalDryTransitionSeconds, tier),
    decalFadeFraction: resolve(renderingConfig.bloodDecalFadeFraction, tier),
    decalStainChance: resolve(renderingConfig.bloodDecalStainChance, tier),
    wallSplatReachMeters: resolve(renderingConfig.bloodWallSplatReachMeters, tier),
    wallSplatCount: resolve(renderingConfig.bloodWallSplatCount, tier),
    decalDimFactor: resolve(renderingConfig.bloodDecalDimFactor, tier),
    dropletsPerHit: resolve(renderingConfig.bloodDropletsPerHit, tier),
    severExtraDroplets: resolve(renderingConfig.bloodSeverExtraDroplets, tier),
    dropletSpeedMinMps: resolve(renderingConfig.bloodDropletSpeedMinMps, tier),
    dropletSpeedMaxMps: resolve(renderingConfig.bloodDropletSpeedMaxMps, tier),
    dropletUpwardMps: resolve(renderingConfig.bloodDropletUpwardMps, tier),
    spreadRad: resolve(renderingConfig.bloodSpreadRad, tier),
    critSpreadRad: resolve(renderingConfig.bloodCritSpreadRad, tier),
    dropletSizeMeters: resolve(renderingConfig.bloodDropletSizeMeters, tier),
    distantSimplifyMeters: resolve(renderingConfig.bloodDistantSimplifyMeters, tier),
    distantCountScale: resolve(renderingConfig.bloodDistantCountScale, tier),
    footstepCadenceSeconds: resolve(renderingConfig.bloodFootstepCadenceSeconds, tier),
    footstepStrideOffsetMeters: resolve(renderingConfig.bloodFootstepStrideOffsetMeters, tier),
    footstepPrintSizeMeters: resolve(renderingConfig.bloodFootstepPrintSizeMeters, tier),
    footstepRangeMeters: resolve(renderingConfig.bloodFootstepRangeMeters, tier),
    footstepWetnessGainPerHit: resolve(renderingConfig.bloodFootstepWetnessGainPerHit, tier),
    footstepWetnessDecayPerSecond: resolve(renderingConfig.bloodFootstepWetnessDecayPerSecond, tier),
    footstepWetnessThreshold: resolve(renderingConfig.bloodFootstepWetnessThreshold, tier),
    regionHeights: {
      head: resolve(renderingConfig.combatGoreHeightHeadMeters, tier),
      torso: resolve(renderingConfig.combatGoreHeightTorsoMeters, tier),
      leg: resolve(renderingConfig.combatGoreHeightLegMeters, tier),
    },
  };
}

/** Per-frame context for ingesting blood events. Mirrors combatFeedback's IngestContext + the player pos
 *  used for the wetness/footstep stand-in. goreIntensity 0 fully suppresses (V29); reduceFlashes thins. */
export interface BloodIngestContext {
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cameraZ: number;
  readonly goreIntensity: number;
  readonly reduceFlashes: boolean;
  readonly playerX: number;
  readonly playerZ: number;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Cheap render-local PRNG — VISUAL only, never touches sim/determinism (V2).
let _seed = 0x9e3779b9 >>> 0;
function rnd(): number {
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 0xffffffff;
}

/** Deterministic [0,1) hash of an integer — per-hit "gush" variety keyed on POSITION, so it varies shot to
 *  shot in play but is stable for a given spot (keeps the energy ordering reproducible for unit tests). */
function hash01(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

/**
 * Pure blood simulation (no GPU — unit-tested). SoA droplet pool (swap-removed on landing, hard-capped) +
 * a ring-buffer decal pool (oldest recycled past the cap). The view reads the public SoA each frame to lay
 * out the instanced batches; nothing here touches Three.js.
 */
export class BloodSim {
  // --- droplet SoA (compacted: live entries are [0, dropletCount)) ---
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly dsize: Float32Array;
  readonly fy: Float32Array; // per-droplet projected land height (true floor/slab Y under it, T77/V54)
  readonly dang: Float32Array; // per-droplet LAUNCH angle — the decal streaks along this (air drag kills the
  // landing velocity, so the launch direction is what reads as the travel direction, T77/V54)
  readonly dr: Float32Array;
  readonly dg: Float32Array;
  readonly db: Float32Array;
  private dCount = 0;

  // --- decal SoA (ring buffer) ---
  readonly cx: Float32Array;
  readonly cy: Float32Array; // per-decal world Y — the projected surface height (floor slab or wall, T77/V54)
  readonly cz: Float32Array;
  readonly cnx: Float32Array; // per-decal surface normal (floor ≈ +Y, wall ≈ horizontal) — orients the quad
  readonly cny: Float32Array;
  readonly cnz: Float32Array;
  readonly cRot: Float32Array;
  readonly cLen: Float32Array;
  readonly cWid: Float32Array;
  readonly cr: Float32Array; // CURRENT (dried-toward-target) display colour, recomputed each update
  readonly cg: Float32Array;
  readonly cb: Float32Array;
  private readonly cFreshR: Float32Array; // settled (pre-dry) colour the dry lerp starts from
  private readonly cFreshG: Float32Array;
  private readonly cFreshB: Float32Array;
  private readonly cAge: Float32Array;
  private cHead = 0;
  private cCount = 0;

  readonly dryTarget = DRY_TARGET;

  // hitReaction is position-less; pair it with the following bloodSpray (emission order, like combatFeedback).
  private pending: { energy: number; dirX: number; dirZ: number; region: AnatomyRegion } | null = null;
  private lastImpact: { x: number; y: number; z: number; dirX: number; dirZ: number; fy: number } | null = null;

  /** Render-side, read-only surface projector (T77/V54). Null in unit tests → decals fall back to the flat
   *  base floor height (the documented open-ground default, NOT a brittle fallback masking a bug). */
  private projector: SurfaceProjector | null = null;

  // Footstep stand-in: a "wetness" accumulator fed by blood near the player + a cadence/side tracker.
  private wetness = 0;
  private playerX = 0;
  private playerZ = 0;
  private prevPlayerX = 0;
  private prevPlayerZ = 0;
  private havePlayer = false;
  private footTimer = 0;
  private footSide = 1;

  constructor(readonly settings: BloodSettings) {
    const D = Math.max(1, settings.dropletPoolSize);
    const C = Math.max(1, settings.decalPoolSize);
    this.px = new Float32Array(D);
    this.py = new Float32Array(D);
    this.pz = new Float32Array(D);
    this.vx = new Float32Array(D);
    this.vy = new Float32Array(D);
    this.vz = new Float32Array(D);
    this.dsize = new Float32Array(D);
    this.fy = new Float32Array(D);
    this.dang = new Float32Array(D);
    this.dr = new Float32Array(D);
    this.dg = new Float32Array(D);
    this.db = new Float32Array(D);
    this.cx = new Float32Array(C);
    this.cy = new Float32Array(C);
    this.cz = new Float32Array(C);
    this.cnx = new Float32Array(C);
    this.cny = new Float32Array(C);
    this.cnz = new Float32Array(C);
    this.cRot = new Float32Array(C);
    this.cLen = new Float32Array(C);
    this.cWid = new Float32Array(C);
    this.cr = new Float32Array(C);
    this.cg = new Float32Array(C);
    this.cb = new Float32Array(C);
    this.cFreshR = new Float32Array(C);
    this.cFreshG = new Float32Array(C);
    this.cFreshB = new Float32Array(C);
    this.cAge = new Float32Array(C);
  }

  get dropletCount(): number {
    return this.dCount;
  }
  get decalCount(): number {
    return this.cCount;
  }
  get wetness01(): number {
    return this.wetness;
  }

  /** Inject the render-side surface projector (T77/V54). Called once by BloodView with the scene structures. */
  setProjector(projector: SurfaceProjector | null): void {
    this.projector = projector;
  }

  /** Consume one frame's drained VisualEvents. `goreIntensity` 0 fully suppresses (V29). */
  consume(events: readonly VisualEvent[], ctx: BloodIngestContext): void {
    // Track the player position every frame (even with no events) for the footstep stand-in.
    this.playerX = ctx.playerX;
    this.playerZ = ctx.playerZ;
    if (!this.havePlayer) {
      this.prevPlayerX = ctx.playerX;
      this.prevPlayerZ = ctx.playerZ;
      this.havePlayer = true;
    }
    if (ctx.goreIntensity <= 0) {
      this.pending = null;
      return; // V29 — fully suppressed.
    }
    for (const e of events) {
      switch (e.kind) {
        case 'hitReaction':
          this.pending = { energy: clamp01(e.energy), dirX: e.dirX, dirZ: e.dirZ, region: e.region };
          break;
        case 'bloodSpray': {
          const dist = Math.hypot(e.x - ctx.cameraX, e.y - ctx.cameraY, e.z - ctx.cameraZ);
          const energy = this.pending ? this.pending.energy : 1;
          const region: AnatomyRegion = this.pending ? this.pending.region : 'torsoUpper';
          const dirX = this.pending ? this.pending.dirX : e.dirX;
          const dirZ = this.pending ? this.pending.dirZ : e.dirZ;
          const y = e.y + regionImpactHeight(region, this.settings.regionHeights);
          const crit = region === 'head'; // headshot tightens the jet (read as a crit)
          // Resolve the true floor/slab height under the impact ONCE (interior floors sit above the street);
          // reuse it for every droplet of this hit (they land near the impact). One raycast per hit (V8/V24).
          const landY = this.resolveFloorY(e.x, y, e.z);
          this.spray(e.x, y, e.z, dirX, dirZ, goreColor('blood'), energy, dist, ctx, crit, landY);
          // Wall behind the struck body catches a vertical splat (the spray travels along the hit vector).
          this.spawnWallSplat(e.x, y, e.z, dirX, dirZ, goreColor('blood'), dist, ctx);
          this.addWetness(e.x, e.z);
          this.lastImpact = { x: e.x, y, z: e.z, dirX, dirZ, fy: landY };
          this.pending = null;
          break;
        }
        case 'partDetached': {
          // Extra blood at the last impact point (the limb chunk itself is GibView's job).
          const at = this.lastImpact;
          if (at) {
            const dist = Math.hypot(at.x - ctx.cameraX, at.y - ctx.cameraY, at.z - ctx.cameraZ);
            this.sprayN(
              at.x,
              at.y,
              at.z,
              at.dirX,
              at.dirZ,
              goreColor('blood'),
              this.settings.severExtraDroplets,
              dist,
              ctx,
              false,
              1,
              at.fy,
            );
            this.addWetness(at.x, at.z);
          }
          break;
        }
        case 'soundEmitted':
          break; // not gore.
      }
    }
  }

  /** Resolve the true floor/slab height under (x,z) via the surface projector, cast down from `fromY` (the
   *  impact height, below the roof); the flat base floor if there is no projector or nothing below. */
  private resolveFloorY(x: number, z: number, fromY: number): number {
    const hit = this.projector ? this.projector.floorBelow(x, fromY, z) : null;
    return hit ? hit.y : this.settings.floorYMeters;
  }

  /** Energy-weighted directional jet — count derives from base * energy with a LOW-skewed per-hit gush so
   *  most hits are a modest spritz and only the occasional one erupts (T77/V54). */
  private spray(
    x: number,
    y: number,
    z: number,
    dirX: number,
    dirZ: number,
    color: Color,
    energy: number,
    dist: number,
    ctx: BloodIngestContext,
    crit: boolean,
    landY: number,
  ): void {
    // Quadratic energy skew (low hits stay small, headshots erupt) × a position-keyed gush for shot-to-shot
    // variety. Both are monotone-bounded so a strong hit always reads bigger than a weak one.
    const skew = 0.3 + 0.7 * energy * energy;
    const gush = 0.7 + 0.6 * hash01(Math.round(x * 73.1 + z * 19.7));
    const base = Math.max(1, Math.round(this.settings.dropletsPerHit * skew * gush));
    this.sprayN(x, y, z, dirX, dirZ, color, base, dist, ctx, crit, energy, landY);
  }

  private sprayN(
    x: number,
    y: number,
    z: number,
    dirX: number,
    dirZ: number,
    color: Color,
    baseCount: number,
    dist: number,
    ctx: BloodIngestContext,
    crit: boolean,
    energy = 1,
    landY = this.settings.floorYMeters,
  ): void {
    const s = this.settings;
    let n = baseCount;
    if (dist > s.distantSimplifyMeters) n = Math.max(1, Math.round(n * s.distantCountScale)); // V8
    if (ctx.reduceFlashes) n = Math.max(1, Math.round(n * 0.5)); // V29 — thin counts
    n = Math.max(1, Math.round(n * ctx.goreIntensity)); // V29 — intensity scales volume
    const hasDir = dirX * dirX + dirZ * dirZ > 1e-6;
    const baseAng = hasDir ? Math.atan2(dirZ, dirX) : 0;
    const spread = crit ? s.critSpreadRad : s.spreadRad;
    const sizeMul = 0.6 + 0.5 * energy; // smaller airborne droplets (T77/V54)
    for (let k = 0; k < n; k++) {
      if (this.dCount >= this.px.length) break; // hard cap (V24) — never grows.
      const i = this.dCount++;
      const ang = hasDir ? baseAng + (rnd() - 0.5) * spread : rnd() * Math.PI * 2;
      const sp = s.dropletSpeedMinMps + rnd() * (s.dropletSpeedMaxMps - s.dropletSpeedMinMps);
      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      this.vx[i] = Math.cos(ang) * sp;
      this.vy[i] = s.dropletUpwardMps * (0.6 + 0.4 * rnd());
      this.vz[i] = Math.sin(ang) * sp;
      this.dsize[i] = s.dropletSizeMeters * (0.35 + rnd() * rnd() * 1.4) * sizeMul;
      this.fy[i] = landY;
      this.dang[i] = ang;
      this.dr[i] = color.r;
      this.dg[i] = color.g;
      this.db[i] = color.b;
    }
  }

  /** A struck body in front of a wall paints it: raycast along the spray direction; if a vertical surface is
   *  within reach, stamp a small lopsided cluster of decals oriented to the wall normal (vertical streaks). */
  private spawnWallSplat(
    x: number,
    y: number,
    z: number,
    dirX: number,
    dirZ: number,
    color: Color,
    dist: number,
    ctx: BloodIngestContext,
  ): void {
    const s = this.settings;
    if (s.wallSplatReachMeters <= 0 || s.wallSplatCount <= 0) return;
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-6 || !this.projector) return;
    const wh = this.projector.wallAlong(x, y, z, dirX / len, dirZ / len, s.wallSplatReachMeters);
    if (!wh || Math.abs(wh.ny) > 0.5) return; // need a vertical-ish surface (skip floors/roof)
    let n = s.wallSplatCount;
    if (dist > s.distantSimplifyMeters) n = Math.max(1, Math.round(n * s.distantCountScale)); // V8
    if (ctx.reduceFlashes) n = Math.max(1, Math.round(n * 0.5)); // V29
    n = Math.max(0, Math.round(n * ctx.goreIntensity)); // V29
    // In-plane basis on the wall: a horizontal tangent (n × up) + the true up, so jitter spreads the cluster.
    const tx = -wh.nz; // cross((nx,0,nz),(0,1,0)) on the XZ plane → (-nz, 0, nx)
    const tz = wh.nx;
    for (let k = 0; k < n; k++) {
      const jh = (rnd() - 0.5) * 0.5; // ±0.25 m horizontal scatter
      const jv = (rnd() - 0.5) * 0.6; // ±0.3 m vertical scatter
      this.landDecal(
        wh.x + tx * jh + (rnd() - 0.5) * 0.02,
        wh.y + jv,
        wh.z + tz * jh,
        0, // wall decals run vertically — travel angle is unused
        0,
        wh.nx,
        wh.ny,
        wh.nz,
        color.r,
        color.g,
        color.b,
        s.dropletSizeMeters * (1.4 + rnd() * 1.6),
        true,
      );
    }
  }

  /** Stamp a settled, directional decal (lobed teardrop, elongated along travel) onto a surface (floor or
   *  wall) into the ring buffer. Floor decals lie flat + streak along the impact velocity; wall decals stand
   *  vertical + run downward. `nx,ny,nz` is the surface normal the quad is oriented to (T77/V54). */
  private landDecal(
    x: number,
    y: number,
    z: number,
    travelAngle: number,
    travelSpeed: number,
    nx: number,
    ny: number,
    nz: number,
    r: number,
    g: number,
    b: number,
    size: number,
    isWall: boolean,
  ): void {
    const speed = travelSpeed;
    const i = this.cHead;
    this.cHead = (this.cHead + 1) % this.cx.length;
    if (this.cCount < this.cx.length) this.cCount++;
    this.cx[i] = x;
    this.cy[i] = y;
    this.cz[i] = z;
    this.cnx[i] = nx;
    this.cny[i] = ny;
    this.cnz[i] = nz;
    this.cAge[i] = 0;
    // In-plane spin of the length axis: floor → along the travel angle; wall → vertical (gravity run). Jitter both.
    if (isWall) {
      this.cRot[i] = Math.PI / 2 + (rnd() - 0.5) * 0.5;
    } else {
      this.cRot[i] = travelAngle + (rnd() - 0.5) * 0.8;
    }
    // Elongated teardrop: length tracks droplet size + travel speed; width is a fraction of it so the decal
    // always reads as a STREAK (length > width), never a uniform disc (T77/V54).
    const baseLen = size * (1 + (isWall ? 0.6 : 0));
    this.cLen[i] = baseLen * (1 + Math.min(1.6, speed * 0.06)) + rnd() * size * 0.3;
    this.cWid[i] = baseLen * (0.4 + rnd() * 0.22);
    // Settled blood is darker than the fresh airborne spray (soaked-in look); dries further over its life.
    const dim = this.settings.decalDimFactor;
    this.cFreshR[i] = r * dim;
    this.cFreshG[i] = g * dim;
    this.cFreshB[i] = b * dim;
    this.cr[i] = this.cFreshR[i]!;
    this.cg[i] = this.cFreshG[i]!;
    this.cb[i] = this.cFreshB[i]!;
  }

  private addWetness(x: number, z: number): void {
    if (!this.havePlayer) return;
    const d = Math.hypot(this.playerX - x, this.playerZ - z);
    if (d > this.settings.footstepRangeMeters) return;
    const closeness = 1 - d / this.settings.footstepRangeMeters;
    this.wetness += closeness * closeness * this.settings.footstepWetnessGainPerHit;
    if (this.wetness > 4) this.wetness = 4; // bounded accumulator
  }

  update(dt: number): void {
    if (dt < 0) throw new Error(`dt must be non-negative, got ${dt}`);
    const s = this.settings;
    const drag = Math.max(0, 1 - s.airDragPerSecond * dt);
    // Droplets: integrate + fall; on landing, convert a size-weighted fraction to a directional decal.
    for (let i = this.dCount - 1; i >= 0; i--) {
      this.vy[i]! -= s.gravityMps2 * dt;
      this.vx[i]! *= drag;
      this.vz[i]! *= drag;
      this.px[i]! += this.vx[i]! * dt;
      this.py[i]! += this.vy[i]! * dt;
      this.pz[i]! += this.vz[i]! * dt;
      if (this.py[i]! <= this.fy[i]!) {
        // Only a fraction of droplets stain (size-weighted) — keeps the floor calm (T77/V54). They land on
        // the projected floor/slab height (fy), so interior floors get visible decals (the indoors fix).
        if (rnd() < Math.min(1, (this.dsize[i]! / s.dropletSizeMeters) * s.decalStainChance)) {
          this.landDecal(this.px[i]!, this.fy[i]!, this.pz[i]!, this.dang[i]!, Math.hypot(this.vx[i]!, this.vz[i]!), 0, 1, 0, this.dr[i]!, this.dg[i]!, this.db[i]!, this.dsize[i]!, false);
        }
        const last = --this.dCount;
        if (i !== last) this.moveDroplet(last, i);
      }
    }
    // Decals: hold fresh briefly, DARKEN to the dried-blood colour, linger dried for the long remainder,
    // then a gentle end-of-life fade into the floor shadow before the ring buffer recycles (T77/V54).
    const fadeStart = s.decalLifeSeconds * (1 - s.decalFadeFraction);
    for (let i = 0; i < this.cCount; i++) {
      this.cAge[i]! += dt;
      const age = this.cAge[i]!;
      const dryT = age <= s.decalFreshSeconds ? 0 : Math.min(1, (age - s.decalFreshSeconds) / s.decalDryTransitionSeconds);
      let r = this.cFreshR[i]! + (DRY_TARGET.r - this.cFreshR[i]!) * dryT;
      let g = this.cFreshG[i]! + (DRY_TARGET.g - this.cFreshG[i]!) * dryT;
      let b = this.cFreshB[i]! + (DRY_TARGET.b - this.cFreshB[i]!) * dryT;
      if (age > fadeStart) {
        const k = Math.min(1, (age - fadeStart) / (s.decalLifeSeconds * s.decalFadeFraction));
        r += (FLOOR_FADE.r - r) * k;
        g += (FLOOR_FADE.g - g) * k;
        b += (FLOOR_FADE.b - b) * k;
      }
      this.cr[i] = r;
      this.cg[i] = g;
      this.cb[i] = b;
    }
    this.footsteps(dt);
  }

  /** Bloody-footprint stand-in: while the player is wet enough and moving, drop alternating-foot floor
   *  decals on a cadence. Reuses the capped decal pool. Wetness decays as the blood dries (V24/V29). */
  private footsteps(dt: number): void {
    const s = this.settings;
    this.wetness = Math.max(0, this.wetness - s.footstepWetnessDecayPerSecond * dt);
    const mvx = this.playerX - this.prevPlayerX;
    const mvz = this.playerZ - this.prevPlayerZ;
    const moved = Math.hypot(mvx, mvz);
    this.prevPlayerX = this.playerX;
    this.prevPlayerZ = this.playerZ;
    this.footTimer -= dt;
    if (this.wetness < s.footstepWetnessThreshold) return;
    if (moved < 0.015 || this.footTimer > 0) return;
    const inv = 1 / moved;
    const perpx = -mvz * inv;
    const perpz = mvx * inv;
    this.footSide = -this.footSide;
    const fx = this.playerX + perpx * s.footstepStrideOffsetMeters * this.footSide;
    const fz = this.playerZ + perpz * s.footstepStrideOffsetMeters * this.footSide;
    const cover = Math.min(1, this.wetness / 4);
    // Cast the footstep floor probe down from torso height (above any floor slab, below the roof).
    const fy = this.resolveFloorY(fx, fz, s.regionHeights.torso);
    // Small + subtle prints that grow only modestly with coverage (T77/V54 — not blobby puddles).
    this.landDecal(fx, fy, fz, Math.atan2(mvz, mvx), moved, 0, 1, 0, BLOOD.r * 0.85, BLOOD.g, BLOOD.b, s.footstepPrintSizeMeters * (0.6 + cover * 0.8), false);
    this.footTimer = Math.max(0.04, s.footstepCadenceSeconds - cover * 0.08); // soaked → closer prints
  }

  private moveDroplet(from: number, to: number): void {
    this.px[to] = this.px[from]!;
    this.py[to] = this.py[from]!;
    this.pz[to] = this.pz[from]!;
    this.vx[to] = this.vx[from]!;
    this.vy[to] = this.vy[from]!;
    this.vz[to] = this.vz[from]!;
    this.dsize[to] = this.dsize[from]!;
    this.fy[to] = this.fy[from]!;
    this.dang[to] = this.dang[from]!;
    this.dr[to] = this.dr[from]!;
    this.dg[to] = this.dg[from]!;
    this.db[to] = this.db[from]!;
  }
}

/** Lobed TEARDROP so decals read as organic splats/streaks, not perfect ellipses (T77/V54). The rim wobbles
 *  with a few harmonics (lobes) and the −X end tapers to a point while the +X end (the streak HEAD, aligned
 *  to travel by the per-decal rotation) stays rounded — so a stretched instance reads as a teardrop streak. */
function makeBlobGeometry(): CircleGeometry {
  const g = new CircleGeometry(0.5, 20);
  const pos = g.attributes.position!;
  for (let i = 1; i < pos.count; i++) {
    const x = pos.getX(i)!;
    const y = pos.getY(i)!;
    const ang = Math.atan2(y, x);
    const lobe = 1 + 0.2 * Math.sin(ang * 3 + 0.6) + 0.12 * Math.sin(ang * 5 - 1.1) + 0.07 * Math.sin(ang * 8);
    // Taper the tail (−X, ang≈±π) to a point; keep the head (+X, ang≈0) round → asymmetric teardrop.
    const taper = 0.55 + 0.45 * (0.5 + 0.5 * Math.cos(ang));
    const f = lobe * taper;
    // Shift slightly toward +X so the rounded head leads and the pointed tail trails (centroid bias).
    pos.setXY(i, x * f + 0.12, y * f);
  }
  pos.needsUpdate = true;
  return g;
}

const DECAL_DEFAULT_NORMAL = new Vector3(0, 0, 1); // CircleGeometry faces +Z before orientation
const DECAL_SURFACE_OFFSET = 0.02; // m — lift the decal a hair off the surface along its normal (no z-fight)

/**
 * Thin GPU view: owns the two InstancedMeshes (droplets + floor decals) and mirrors the pure BloodSim state
 * onto them each frame. r184 binding-safe — solid geometry + pre-created instanceColor, MeshBasicMaterial
 * {toneMapped:false}. Every resource is tracked for disposal (V24).
 */
export class BloodView {
  readonly sim: BloodSim;
  private readonly dropMesh: InstancedMesh;
  private readonly decalMesh: InstancedMesh;
  private readonly dummy = new Object3D();
  private readonly tmp = new Color();
  private readonly normalScratch = new Vector3();

  constructor(settings: BloodSettings, registry: ResourceRegistry) {
    this.sim = new BloodSim(settings);
    const dropGeo = registry.track(new SphereGeometry(1, 6, 5), 'geometry', 'blood.dropletGeo');
    const dropMat = registry.track(new MeshBasicMaterial({ name: 'blood.droplet', toneMapped: false }), 'material', 'blood.dropletMat');
    this.dropMesh = registry.track(new InstancedMesh(dropGeo, dropMat, Math.max(1, settings.dropletPoolSize)), 'buffer', 'blood.dropletMesh');
    primeInstanced(this.dropMesh);

    const decalGeo = registry.track(makeBlobGeometry(), 'geometry', 'blood.decalGeo');
    const decalMat = registry.track(new MeshBasicMaterial({ name: 'blood.decal', toneMapped: false }), 'material', 'blood.decalMat');
    this.decalMesh = registry.track(new InstancedMesh(decalGeo, decalMat, Math.max(1, settings.decalPoolSize)), 'buffer', 'blood.decalMesh');
    primeInstanced(this.decalMesh);
    this.decalMesh.renderOrder = 1; // over the floor, under airborne droplets
  }

  /** Add the blood meshes to the scene graph (parent owns graph membership; registry owns disposal). */
  attachTo(scene: Scene | Object3D): void {
    scene.add(this.dropMesh, this.decalMesh);
  }

  consume(events: readonly VisualEvent[], ctx: BloodIngestContext): void {
    this.sim.consume(events, ctx);
  }

  /** Advance the sim then mirror its SoA onto the instanced batches. */
  update(dt: number): void {
    this.sim.update(dt);
    const sim = this.sim;
    const nd = sim.dropletCount;
    for (let i = 0; i < nd; i++) {
      this.dummy.position.set(sim.px[i]!, sim.py[i]!, sim.pz[i]!);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(sim.dsize[i]!);
      this.dummy.updateMatrix();
      this.dropMesh.setMatrixAt(i, this.dummy.matrix);
      this.dropMesh.setColorAt(i, this.tmp.setRGB(sim.dr[i]!, sim.dg[i]!, sim.db[i]!));
    }
    this.dropMesh.count = nd;
    this.dropMesh.instanceMatrix.needsUpdate = true;
    if (this.dropMesh.instanceColor) this.dropMesh.instanceColor.needsUpdate = true;

    const nc = sim.decalCount;
    for (let i = 0; i < nc; i++) {
      // Orient the quad to the projected surface normal (floor → +Y / flat; wall → vertical), nudged a hair
      // off the surface along the normal so it never z-fights the floor slab or wall, then spin IN-PLANE
      // (cRot streaks the length toward travel on a floor, or downward on a wall).
      const nx = sim.cnx[i]!;
      const ny = sim.cny[i]!;
      const nz = sim.cnz[i]!;
      this.normalScratch.set(nx, ny, nz);
      this.dummy.position.set(sim.cx[i]! + nx * DECAL_SURFACE_OFFSET, sim.cy[i]! + ny * DECAL_SURFACE_OFFSET, sim.cz[i]! + nz * DECAL_SURFACE_OFFSET);
      this.dummy.quaternion.setFromUnitVectors(DECAL_DEFAULT_NORMAL, this.normalScratch);
      this.dummy.rotateZ(sim.cRot[i]!);
      this.dummy.scale.set(sim.cLen[i]!, sim.cWid[i]!, 1);
      this.dummy.updateMatrix();
      this.decalMesh.setMatrixAt(i, this.dummy.matrix);
      this.decalMesh.setColorAt(i, this.tmp.setRGB(sim.cr[i]!, sim.cg[i]!, sim.cb[i]!));
    }
    this.decalMesh.count = nc;
    this.decalMesh.instanceMatrix.needsUpdate = true;
    if (this.decalMesh.instanceColor) this.decalMesh.instanceColor.needsUpdate = true;
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
