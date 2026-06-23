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
// JUICE upgrade (T79): airborne droplets now STRETCH along velocity (motion streaks, not balls); most hits
// GUARANTEE >=1 floor splat (blood never falls THROUGH the floor); a spray within coatRange splatters gore
// onto the PLAYER BODY — a body-gore ring buffer stores BODY-LOCAL offsets and the view repositions them to
// playerWorldPos + localOffset each frame (NOT parented to the blockScene player mesh; the sim already tracks
// the player world pos), lingering ~10× the floor wet phase then drying + shrinking. Wetness now also builds
// from walking through FRESH floor puddles (own footprints excluded) → a bloody footprint trail.
//
// STILL DEFERRED (needs T70 player mesh hooks + a positioned death VisualEvent — not ours to add): the
// death-clutch gib burst. Tie T54/T55.

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
  // ---- JUICE upgrade (T79) ----
  readonly dropletStreakLengthFactor: number;
  readonly coatRangeMeters: number;
  readonly playerGorePoolSize: number;
  readonly playerGoreLifeSeconds: number;
  readonly playerGoreSizeMeters: number;
  readonly playerGoreBrightness: number;
  readonly playerGoreBodyRadiusMeters: number;
  readonly playerGoreBodyHeightMinMeters: number;
  readonly playerGoreBodyHeightMaxMeters: number;
  readonly playerGoreSplatsPerCoat: number;
  readonly puddlePickupRadiusMeters: number;
  readonly puddlePickupWetnessPerSecond: number;
  // ---- Bug A: zombie body-gore (follows the struck body to the corpse) ----
  readonly zombieGorePoolSize: number;
  readonly zombieGoreSplatsPerHit: number;
  readonly regionHeights: RegionHeights;
}

/**
 * Bug A — the current world transform of a struck body, resolved by the runtime each frame from sim authority
 * (the live zombie SoA while alive, the corpse record once it topples). Pure-view (V2): the blood layer READS
 * this to keep gore stuck on the body; it never writes the sim back. Returned by entity id, never a raw slot
 * (V26). `null` = the body is gone (despawned with no corpse / corpse pruned) → its gore fades out at once.
 */
export interface BodyAnchor {
  readonly x: number;
  readonly y: number; // body BASE world Y (feet on the ground/slab)
  readonly z: number;
  readonly heading: number; // body facing (yaw) — the toppled corpse lies along this
  /** 0 = upright/standing, 1 = fully toppled flat on the ground (corpse). The death→floor transition. */
  readonly lying: number;
  /** World Y the toppled body rests at (floor/slab top under it). */
  readonly groundY: number;
}

/** Render-side, read-only resolver of a struck body's current transform by entity id (Bug A). */
export interface BodyAnchorResolver {
  resolve(entity: number): BodyAnchor | null;
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
    dropletStreakLengthFactor: resolve(renderingConfig.bloodDropletStreakLengthFactor, tier),
    coatRangeMeters: resolve(renderingConfig.bloodCoatRangeMeters, tier),
    playerGorePoolSize: resolve(renderingConfig.bloodPlayerGorePoolSize, tier),
    playerGoreLifeSeconds: resolve(renderingConfig.bloodPlayerGoreLifeSeconds, tier),
    playerGoreSizeMeters: resolve(renderingConfig.bloodPlayerGoreSizeMeters, tier),
    playerGoreBrightness: resolve(renderingConfig.bloodPlayerGoreBrightness, tier),
    playerGoreBodyRadiusMeters: resolve(renderingConfig.bloodPlayerGoreBodyRadiusMeters, tier),
    playerGoreBodyHeightMinMeters: resolve(renderingConfig.bloodPlayerGoreBodyHeightMinMeters, tier),
    playerGoreBodyHeightMaxMeters: resolve(renderingConfig.bloodPlayerGoreBodyHeightMaxMeters, tier),
    playerGoreSplatsPerCoat: resolve(renderingConfig.bloodPlayerGoreSplatsPerCoat, tier),
    puddlePickupRadiusMeters: resolve(renderingConfig.bloodPuddlePickupRadiusMeters, tier),
    puddlePickupWetnessPerSecond: resolve(renderingConfig.bloodPuddlePickupWetnessPerSecond, tier),
    zombieGorePoolSize: resolve(renderingConfig.bloodZombieGorePoolSize, tier),
    zombieGoreSplatsPerHit: resolve(renderingConfig.bloodZombieGoreSplatsPerHit, tier),
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
  private readonly cFoot: Uint8Array; // 1 = a footprint decal — excluded from puddle pickup so a trail ends (T79)
  private cHead = 0;
  private cCount = 0;

  // --- player BODY-gore SoA (ring buffer, T79). Offsets are BODY-LOCAL (around/up the body); the view adds
  //     them to the tracked player world pos each frame, so gore FOLLOWS the player without being parented. ---
  readonly pgX: Float32Array; // body-local X offset
  readonly pgY: Float32Array; // body-local height up the body
  readonly pgZ: Float32Array; // body-local Z offset
  readonly pgSize: Float32Array;
  readonly pgVis: Float32Array; // 0..1 visibility/shrink factor recomputed each update (1 fresh → 0 dried away)
  readonly pgr: Float32Array; // fresh (bright) splat colour; the view darkens it by pgVis as it dries
  readonly pgg: Float32Array;
  readonly pgb: Float32Array;
  private readonly pgAge: Float32Array;
  private readonly pgLife: Float32Array;
  private pgHead = 0;
  private pgCount = 0;

  // --- ZOMBIE BODY-gore SoA (ring buffer, Bug A). Each splat stores the struck entity + a BODY-LOCAL offset
  //     (around/up the standing body). update() re-projects every splat to the body's CURRENT transform via
  //     the injected resolver (live body while alive, toppled corpse once dead), writing the world position
  //     into zgWX/zgWY/zgWZ — so the gore travels WITH the body down to the floor (never frozen mid-air). ---
  readonly zgEntity: Int32Array; // struck entity id (-1 = free)
  readonly zgLX: Float32Array; // body-local X offset (around the body)
  readonly zgLY: Float32Array; // body-local height up the body
  readonly zgLZ: Float32Array; // body-local Z offset (around the body)
  readonly zgWX: Float32Array; // re-projected world X (read by the view)
  readonly zgWY: Float32Array; // re-projected world Y
  readonly zgWZ: Float32Array; // re-projected world Z
  readonly zgSize: Float32Array;
  readonly zgVis: Float32Array; // 0..1 visibility/shrink (1 fresh → 0 dried/gone), recomputed each update
  readonly zgr: Float32Array;
  readonly zgg: Float32Array;
  readonly zgb: Float32Array;
  private readonly zgAge: Float32Array;
  private readonly zgLife: Float32Array;
  private zgHead = 0;
  private zgCount = 0;

  /** Bug A — resolves a struck body's current transform by entity id each frame (null when not wired → no
   *  zombie gore is created, identical to the prior behaviour). Injected once by the runtime via the view. */
  private bodyAnchors: BodyAnchorResolver | null = null;

  readonly dryTarget = DRY_TARGET;

  // hitReaction is position-less; pair it with the following bloodSpray (emission order, like combatFeedback).
  // It carries the struck `entity` so the paired spray can anchor body-gore to that body (Bug A).
  private pending: { energy: number; dirX: number; dirZ: number; region: AnatomyRegion; entity: number } | null = null;
  private lastImpact: { x: number; y: number; z: number; dirX: number; dirZ: number; fy: number; entity: number } | null = null;

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
    this.cFoot = new Uint8Array(C);
    const P = Math.max(0, settings.playerGorePoolSize);
    this.pgX = new Float32Array(P);
    this.pgY = new Float32Array(P);
    this.pgZ = new Float32Array(P);
    this.pgSize = new Float32Array(P);
    this.pgVis = new Float32Array(P);
    this.pgr = new Float32Array(P);
    this.pgg = new Float32Array(P);
    this.pgb = new Float32Array(P);
    this.pgAge = new Float32Array(P);
    this.pgLife = new Float32Array(P);
    const Z = Math.max(0, settings.zombieGorePoolSize);
    this.zgEntity = new Int32Array(Z).fill(-1);
    this.zgLX = new Float32Array(Z);
    this.zgLY = new Float32Array(Z);
    this.zgLZ = new Float32Array(Z);
    this.zgWX = new Float32Array(Z);
    this.zgWY = new Float32Array(Z);
    this.zgWZ = new Float32Array(Z);
    this.zgSize = new Float32Array(Z);
    this.zgVis = new Float32Array(Z);
    this.zgr = new Float32Array(Z);
    this.zgg = new Float32Array(Z);
    this.zgb = new Float32Array(Z);
    this.zgAge = new Float32Array(Z);
    this.zgLife = new Float32Array(Z);
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
  get playerGoreCount(): number {
    return this.pgCount;
  }
  /** Live zombie body-gore splats (Bug A) — the view mirrors [0, zombieGoreCount) onto its instanced batch. */
  get zombieGoreCount(): number {
    return this.zgCount;
  }
  /** Tracked player world position (the body-gore layer follows it; the sim never feeds the sim, V2). */
  get trackedPlayerX(): number {
    return this.playerX;
  }
  get trackedPlayerZ(): number {
    return this.playerZ;
  }

  /** Inject the render-side surface projector (T77/V54). Called once by BloodView with the scene structures. */
  setProjector(projector: SurfaceProjector | null): void {
    this.projector = projector;
  }

  /** Inject the body-anchor resolver (Bug A). Until set (null) no zombie body-gore is created, so behaviour is
   *  unchanged. Once wired, blood that lands on a zombie body sticks to it and follows it to the floor. */
  setBodyAnchors(resolver: BodyAnchorResolver | null): void {
    this.bodyAnchors = resolver;
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
          this.pending = { energy: clamp01(e.energy), dirX: e.dirX, dirZ: e.dirZ, region: e.region, entity: e.target as number };
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
          this.coatPlayer(e.x, e.z, goreColor('blood'), energy, ctx); // T79 — splatter gore onto the player body
          // Bug A — coat the STRUCK zombie body itself; the gore sticks to it and follows it to the floor.
          const entity = this.pending ? this.pending.entity : -1;
          this.coatZombie(entity, goreColor('blood'), energy, ctx);
          this.addWetness(e.x, e.z);
          this.lastImpact = { x: e.x, y, z: e.z, dirX, dirZ, fy: landY, entity };
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
            this.coatPlayer(at.x, at.z, goreColor('blood'), 1, ctx); // T79 — a sever near the player coats them
            this.coatZombie(at.entity, goreColor('blood'), 1, ctx); // Bug A — sever spatters the body
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
    // GUARANTEE >=1 floor splat per visible hit (T79): a settled splat pooled under/just ahead of the struck
    // body so blood never appears to fall THROUGH the floor. Streaks along travel, sized by energy. All offsets
    // derive from existing tunables (no magic numbers); pooled by the decal ring buffer.
    const s = this.settings;
    const dlen = Math.hypot(dirX, dirZ);
    const ux = dlen > 1e-6 ? dirX / dlen : 0;
    const uz = dlen > 1e-6 ? dirZ / dlen : 0;
    const splatSize = s.dropletSizeMeters * (3 + 3 * energy);
    const ang = dlen > 1e-6 ? Math.atan2(dirZ, dirX) : rnd() * Math.PI * 2;
    this.landDecal(x + ux * splatSize * 0.5, landY, z + uz * splatSize * 0.5, ang, s.dropletSpeedMinMps * 0.4, 0, 1, 0, color.r, color.g, color.b, splatSize, false, false);
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
        false,
      );
    }
  }

  /** Splatter gore onto the PLAYER BODY when a spray happens within coatRange (T79). Stores BODY-LOCAL offsets
   *  (around + up the body, biased to the side facing the blood source) into a ring buffer; the view repositions
   *  them to playerWorldPos + localOffset each frame (NOT parented to the player mesh). Pooled + capped (V24);
   *  render-local RNG only (V2/V3). Brighter than floor blood so it reads on the dark body. */
  private coatPlayer(srcX: number, srcZ: number, color: Color, energy: number, ctx: BloodIngestContext): void {
    const s = this.settings;
    if (!this.havePlayer || this.pgX.length === 0 || ctx.goreIntensity <= 0) return;
    const dx = this.playerX - srcX;
    const dz = this.playerZ - srcZ;
    const dist = Math.hypot(dx, dz);
    if (dist > s.coatRangeMeters) return;
    const closeness = 1 - dist / s.coatRangeMeters; // 1 = right on top of the player
    let count = Math.max(1, Math.round(closeness * closeness * s.playerGoreSplatsPerCoat * (0.4 + energy * 0.8)));
    if (ctx.reduceFlashes) count = Math.max(1, Math.round(count * 0.5)); // V29 — thin
    count = Math.max(1, Math.round(count * ctx.goreIntensity)); // V29 — intensity scales coating volume
    const srcAng = Math.atan2(-dz, -dx); // the body side facing the blood source
    const R = s.playerGoreBodyRadiusMeters;
    const hRange = s.playerGoreBodyHeightMaxMeters - s.playerGoreBodyHeightMinMeters;
    const bright = s.playerGoreBrightness;
    for (let k = 0; k < count; k++) {
      if (this.pgX.length === 0) break;
      const i = this.pgHead;
      this.pgHead = (this.pgHead + 1) % this.pgX.length;
      if (this.pgCount < this.pgX.length) this.pgCount++;
      const ang = srcAng + (rnd() - 0.5) * 2.2; // biased to the near side
      this.pgX[i] = Math.cos(ang) * R;
      this.pgY[i] = s.playerGoreBodyHeightMinMeters + rnd() * hRange;
      this.pgZ[i] = Math.sin(ang) * R;
      this.pgSize[i] = s.playerGoreSizeMeters * (0.7 + rnd() * 0.9);
      this.pgAge[i] = 0;
      this.pgLife[i] = s.playerGoreLifeSeconds * (0.7 + rnd() * 0.6);
      this.pgVis[i] = 1;
      this.pgr[i] = Math.min(1, color.r * bright + 0.06);
      this.pgg[i] = Math.min(1, color.g * bright);
      this.pgb[i] = Math.min(1, color.b * bright);
    }
  }

  /** Splatter gore onto the STRUCK ZOMBIE BODY (Bug A). Anchored to the body's entity with BODY-LOCAL offsets
   *  (around + up the body, biased to the side facing the blood source) into a ring buffer; update() re-projects
   *  each splat to the body's CURRENT transform (live, then the toppled corpse) via the injected resolver — so it
   *  follows the body to the floor instead of hanging where it was standing. No-op until a resolver is wired and
   *  for an unknown entity. Pooled + capped (V24); render-local RNG only (V2/V3). */
  private coatZombie(entity: number, color: Color, energy: number, ctx: BloodIngestContext): void {
    const s = this.settings;
    if (!this.bodyAnchors || this.zgEntity.length === 0 || ctx.goreIntensity <= 0) return;
    if (entity < 0 || !this.bodyAnchors.resolve(entity)) return; // unknown/gone body — nothing to stick to
    let count = Math.max(1, Math.round(s.zombieGoreSplatsPerHit * (0.4 + energy * 0.8)));
    if (ctx.reduceFlashes) count = Math.max(1, Math.round(count * 0.5)); // V29 — thin
    count = Math.max(1, Math.round(count * ctx.goreIntensity)); // V29 — intensity scales coating volume
    const R = s.playerGoreBodyRadiusMeters;
    const hRange = s.playerGoreBodyHeightMaxMeters - s.playerGoreBodyHeightMinMeters;
    const bright = s.playerGoreBrightness;
    for (let k = 0; k < count; k++) {
      const i = this.zgHead;
      this.zgHead = (this.zgHead + 1) % this.zgEntity.length;
      if (this.zgCount < this.zgEntity.length) this.zgCount++;
      const ang = rnd() * Math.PI * 2;
      this.zgEntity[i] = entity;
      this.zgLX[i] = Math.cos(ang) * R;
      this.zgLY[i] = s.playerGoreBodyHeightMinMeters + rnd() * hRange;
      this.zgLZ[i] = Math.sin(ang) * R;
      this.zgSize[i] = s.playerGoreSizeMeters * (0.7 + rnd() * 0.9);
      this.zgAge[i] = 0;
      this.zgLife[i] = s.playerGoreLifeSeconds * (0.7 + rnd() * 0.6);
      this.zgVis[i] = 1;
      this.zgr[i] = Math.min(1, color.r * bright + 0.06);
      this.zgg[i] = Math.min(1, color.g * bright);
      this.zgb[i] = Math.min(1, color.b * bright);
      // Seed the world position immediately so a splat is placed even before the first update() reprojection.
      this.reprojectZombieGore(i);
    }
  }

  /** Re-project one zombie-gore splat from its body-local offset to world space via the current body transform
   *  (Bug A). Interpolates between the upright placement and the toppled (corpse-on-floor) placement by the
   *  anchor's `lying` term, so the gore drops to the floor as the body topples. A vanished body (resolve→null)
   *  collapses the splat (vis 0) so it never hangs frozen in mid-air. */
  private reprojectZombieGore(i: number): void {
    const a = this.bodyAnchors ? this.bodyAnchors.resolve(this.zgEntity[i]!) : null;
    if (!a) {
      this.zgVis[i] = 0;
      return;
    }
    const lx = this.zgLX[i]!;
    const ly = this.zgLY[i]!;
    const lz = this.zgLZ[i]!;
    // Upright: offsets sit around/up the standing body. Toppled: the body lies flat along `heading`, so the
    // up-the-body height maps to a forward ground offset and the around-body offset to a lateral one.
    const ux = a.x + lx;
    const uy = a.y + ly;
    const uz = a.z + lz;
    const ch = Math.cos(a.heading);
    const sh = Math.sin(a.heading);
    const tx = a.x + ch * ly - sh * lx;
    const ty = a.groundY;
    const tz = a.z + sh * ly + ch * lx;
    const t = a.lying < 0 ? 0 : a.lying > 1 ? 1 : a.lying;
    this.zgWX[i] = ux + (tx - ux) * t;
    this.zgWY[i] = uy + (ty - uy) * t;
    this.zgWZ[i] = uz + (tz - uz) * t;
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
    isFootprint: boolean,
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
    this.cFoot[i] = isFootprint ? 1 : 0;
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
          this.landDecal(this.px[i]!, this.fy[i]!, this.pz[i]!, this.dang[i]!, Math.hypot(this.vx[i]!, this.vz[i]!), 0, 1, 0, this.dr[i]!, this.dg[i]!, this.db[i]!, this.dsize[i]!, false, false);
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
    // Player body gore (T79): age slowly so it lingers ~10× the floor wet phase, then dry + shrink at the end.
    // Expired splats collapse to zero visibility (the view scales them to nothing) until the ring buffer reuses
    // them — no compaction needed.
    for (let i = 0; i < this.pgCount; i++) {
      this.pgAge[i]! += dt;
      const t = this.pgAge[i]! / this.pgLife[i]!;
      this.pgVis[i] = t >= 1 ? 0 : 1 - t * t * t; // hold fresh, dry/shrink late
    }
    // Zombie body-gore (Bug A): age (dry/shrink), then RE-PROJECT each splat to the body's current transform
    // so it travels with the body to the floor. A vanished body collapses its splats to nothing (reproject).
    for (let i = 0; i < this.zgCount; i++) {
      this.zgAge[i]! += dt;
      const t = this.zgAge[i]! / this.zgLife[i]!;
      const ageVis = t >= 1 ? 0 : 1 - t * t * t;
      this.reprojectZombieGore(i); // may set zgVis to 0 when the body is gone
      if (this.zgVis[i]! > 0) this.zgVis[i] = ageVis;
    }
    this.pickUpFromPuddles(dt);
    this.footsteps(dt);
  }

  /** Puddle-step pickup (T79): walking over/near a FRESH (still-wet) floor decal soaks the player → builds
   *  wetness → a bloody footprint trail. The player's OWN footprints are excluded so the trail naturally ends
   *  once they step off real blood. Reads only the decal ring buffer (V2). */
  private pickUpFromPuddles(dt: number): void {
    if (!this.havePlayer) return;
    const s = this.settings;
    const r2 = s.puddlePickupRadiusMeters * s.puddlePickupRadiusMeters;
    for (let i = 0; i < this.cCount; i++) {
      if (this.cFoot[i]) continue; // never re-soak from our own prints
      if (this.cny[i]! < 0.5) continue; // floor decals only (not wall splats)
      if (this.cAge[i]! > s.decalFreshSeconds) continue; // only fresh/wet puddles soak in
      const ddx = this.cx[i]! - this.playerX;
      const ddz = this.cz[i]! - this.playerZ;
      if (ddx * ddx + ddz * ddz <= r2) {
        this.wetness = Math.min(4, this.wetness + s.puddlePickupWetnessPerSecond * dt);
        return; // one fresh puddle underfoot is enough this frame
      }
    }
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
    this.landDecal(fx, fy, fz, Math.atan2(mvz, mvx), moved, 0, 1, 0, BLOOD.r * 0.85, BLOOD.g, BLOOD.b, s.footstepPrintSizeMeters * (0.6 + cover * 0.8), false, true);
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
  const g = new CircleGeometry(0.5, 24);
  const pos = g.attributes.position!;
  for (let i = 1; i < pos.count; i++) {
    const x = pos.getX(i)!;
    const y = pos.getY(i)!;
    const ang = Math.atan2(y, x);
    // Stronger harmonic rim wobble (T79) → a more irregular, splatty outline. Per-decal rotation + non-uniform
    // length/width (cRot/cLen/cWid) then break the shared shape so no two instances read the same.
    const lobe = 1 + 0.26 * Math.sin(ang * 3 + 0.6) + 0.15 * Math.sin(ang * 5 - 1.1) + 0.09 * Math.sin(ang * 8 + 0.3) + 0.05 * Math.sin(ang * 11);
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
const DROPLET_LONG_AXIS = new Vector3(1, 0, 0); // the sphere's +X is stretched ALONG the droplet velocity (streak)
// Player-body gore is slapped flat AGAINST the body surface: spread it tangentially and thin it radially so a
// splat hugs the body instead of poking out as a ball (mirrors the reference body-coating look, T79).
const PLAYER_GORE_SPREAD = 1.15;
const PLAYER_GORE_RADIAL_FLATTEN = 0.32;

/** Pure helper (T79): the instance scale of one airborne droplet — its long axis stretches ALONG velocity with
 *  speed (a motion streak) while the cross-section stays = size (a thin streak, never a ball). Unit-tested. */
export function dropletStreakDims(speed: number, size: number, lengthFactor: number): { long: number; cross: number } {
  const sp = speed > 0 ? speed : 0;
  return { long: size * (1 + sp * lengthFactor), cross: size };
}

/**
 * Thin GPU view: owns the two InstancedMeshes (droplets + floor decals) and mirrors the pure BloodSim state
 * onto them each frame. r184 binding-safe — solid geometry + pre-created instanceColor, MeshBasicMaterial
 * {toneMapped:false}. Every resource is tracked for disposal (V24).
 */
export class BloodView {
  readonly sim: BloodSim;
  private readonly dropMesh: InstancedMesh;
  private readonly decalMesh: InstancedMesh;
  private readonly pgMesh: InstancedMesh; // player BODY-gore layer (T79)
  private readonly zgMesh: InstancedMesh; // zombie BODY-gore layer — follows the body to the corpse (Bug A)
  private readonly dummy = new Object3D();
  private readonly tmp = new Color();
  private readonly normalScratch = new Vector3();
  private readonly velScratch = new Vector3();

  constructor(settings: BloodSettings, registry: ResourceRegistry) {
    this.sim = new BloodSim(settings);
    const dropGeo = registry.track(new SphereGeometry(1, 6, 5), 'geometry', 'blood.dropletGeo');
    const dropMat = registry.track(new MeshBasicMaterial({ name: 'blood.droplet', toneMapped: false }), 'material', 'blood.dropletMat');
    this.dropMesh = registry.track(new InstancedMesh(dropGeo, dropMat, Math.max(1, settings.dropletPoolSize)), 'buffer', 'blood.dropletMesh');
    primeInstanced(this.dropMesh);

    const decalGeo = registry.track(makeBlobGeometry(), 'geometry', 'blood.decalGeo');
    // Floor splats keep depth TEST on (so walls / units / the player correctly OCCLUDE them — no blood drawn
    // over the player), but depthWrite OFF + a polygon-offset bias toward the camera so they win the coplanar
    // fight with the floor surface without z-fighting. Visibility indoors is solved at the SOURCE: the
    // cutaway-faded roof/upper-walls stop depth-writing (blockScene) so they don't occlude the interior.
    const decalMat = registry.track(
      new MeshBasicMaterial({
        name: 'blood.decal',
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
      'material',
      'blood.decalMat',
    );
    this.decalMesh = registry.track(new InstancedMesh(decalGeo, decalMat, Math.max(1, settings.decalPoolSize)), 'buffer', 'blood.decalMesh');
    primeInstanced(this.decalMesh);
    this.decalMesh.renderOrder = 1; // draw after the opaque floor, before airborne droplets

    // Player BODY-gore layer (T79): solid faceted blobs slapped on the body. Opaque matter (fades by SHRINK, not
    // alpha) so no transparency needed; depthTest stays ON (V56 — the body/world correctly occludes splats on the
    // far side). Lives in WORLD space and is repositioned to playerWorldPos + body-local offset each frame (NOT
    // parented to the player mesh). Brighter than floor blood so it reads on the dark body.
    const pgGeo = registry.track(new SphereGeometry(1, 7, 6), 'geometry', 'blood.playerGoreGeo');
    const pgMat = registry.track(new MeshBasicMaterial({ name: 'blood.playerGore', toneMapped: false }), 'material', 'blood.playerGoreMat');
    this.pgMesh = registry.track(new InstancedMesh(pgGeo, pgMat, Math.max(1, settings.playerGorePoolSize)), 'buffer', 'blood.playerGoreMesh');
    primeInstanced(this.pgMesh);
    this.pgMesh.renderOrder = 2; // over the body + floor decals so the coating reads

    // Zombie BODY-gore layer (Bug A): same solid faceted-blob look as player gore, but each splat is anchored
    // to the struck body and re-projected to its CURRENT world transform every frame (the sim's BodyAnchor),
    // so coating follows the body — and drops to the floor when it topples to a corpse. depthTest ON (V56).
    const zgGeo = registry.track(new SphereGeometry(1, 7, 6), 'geometry', 'blood.zombieGoreGeo');
    const zgMat = registry.track(new MeshBasicMaterial({ name: 'blood.zombieGore', toneMapped: false }), 'material', 'blood.zombieGoreMat');
    this.zgMesh = registry.track(new InstancedMesh(zgGeo, zgMat, Math.max(1, settings.zombieGorePoolSize)), 'buffer', 'blood.zombieGoreMesh');
    primeInstanced(this.zgMesh);
    this.zgMesh.renderOrder = 2; // over the corpse + floor decals so the coating reads
  }

  /** Add the blood meshes to the scene graph (parent owns graph membership; registry owns disposal). */
  attachTo(scene: Scene | Object3D): void {
    scene.add(this.dropMesh, this.decalMesh, this.pgMesh, this.zgMesh);
  }

  consume(events: readonly VisualEvent[], ctx: BloodIngestContext): void {
    this.sim.consume(events, ctx);
  }

  /** Advance the sim then mirror its SoA onto the instanced batches. */
  update(dt: number): void {
    this.sim.update(dt);
    const sim = this.sim;
    const nd = sim.dropletCount;
    const streakFactor = sim.settings.dropletStreakLengthFactor;
    for (let i = 0; i < nd; i++) {
      this.dummy.position.set(sim.px[i]!, sim.py[i]!, sim.pz[i]!);
      // Stretch the droplet ALONG its velocity so a fast droplet reads as a motion STREAK, not a ball (T79):
      // orient the sphere's long (+X) axis to the velocity vector and scale only that axis with speed.
      const vx = sim.vx[i]!;
      const vy = sim.vy[i]!;
      const vz = sim.vz[i]!;
      const speed = Math.hypot(vx, vy, vz);
      const dims = dropletStreakDims(speed, sim.dsize[i]!, streakFactor);
      if (speed > 1e-4) {
        this.velScratch.set(vx / speed, vy / speed, vz / speed);
        this.dummy.quaternion.setFromUnitVectors(DROPLET_LONG_AXIS, this.velScratch);
        this.dummy.scale.set(dims.long, dims.cross, dims.cross);
      } else {
        this.dummy.quaternion.identity();
        this.dummy.scale.setScalar(dims.cross);
      }
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

    // Player BODY-gore (T79): reposition each splat to the tracked player world pos + its body-local offset, slap
    // it flat against the body surface (radial normal), shrink + darken as it dries. Expired splats (pgVis 0)
    // collapse to zero scale → invisible until the ring buffer reuses them.
    const np = sim.playerGoreCount;
    const px = sim.trackedPlayerX;
    const pz = sim.trackedPlayerZ;
    for (let i = 0; i < np; i++) {
      const vis = sim.pgVis[i]!;
      const sc = sim.pgSize[i]! * vis;
      this.dummy.position.set(px + sim.pgX[i]!, sim.pgY[i]!, pz + sim.pgZ[i]!);
      this.dummy.quaternion.identity();
      this.dummy.rotation.set(0, Math.atan2(sim.pgX[i]!, sim.pgZ[i]!), 0); // face the splat outward from the body
      this.dummy.scale.set(sc * PLAYER_GORE_SPREAD, sc * PLAYER_GORE_SPREAD, sc * PLAYER_GORE_RADIAL_FLATTEN);
      this.dummy.updateMatrix();
      this.pgMesh.setMatrixAt(i, this.dummy.matrix);
      const drk = 0.45 + 0.55 * vis; // darken as it dries
      this.pgMesh.setColorAt(i, this.tmp.setRGB(sim.pgr[i]! * drk, sim.pgg[i]! * drk, sim.pgb[i]! * drk));
    }
    this.pgMesh.count = np;
    this.pgMesh.instanceMatrix.needsUpdate = true;
    if (this.pgMesh.instanceColor) this.pgMesh.instanceColor.needsUpdate = true;

    // Zombie BODY-gore (Bug A): the sim already re-projected each splat to the body's current world transform
    // (zgWX/zgWY/zgWZ) — including the drop to the floor as it toppled — so the view just places + colours each
    // blob there, shrinking + darkening it by its dried visibility. Expired/gone splats collapse to nothing.
    const nz = sim.zombieGoreCount;
    for (let i = 0; i < nz; i++) {
      const vis = sim.zgVis[i]!;
      const sc = sim.zgSize[i]! * vis;
      this.dummy.position.set(sim.zgWX[i]!, sim.zgWY[i]!, sim.zgWZ[i]!);
      this.dummy.quaternion.identity();
      this.dummy.scale.set(sc * PLAYER_GORE_SPREAD, sc * PLAYER_GORE_SPREAD, sc * PLAYER_GORE_RADIAL_FLATTEN);
      this.dummy.updateMatrix();
      this.zgMesh.setMatrixAt(i, this.dummy.matrix);
      const drk = 0.45 + 0.55 * vis; // darken as it dries
      this.zgMesh.setColorAt(i, this.tmp.setRGB(sim.zgr[i]! * drk, sim.zgg[i]! * drk, sim.zgb[i]! * drk));
    }
    this.zgMesh.count = nz;
    this.zgMesh.instanceMatrix.needsUpdate = true;
    if (this.zgMesh.instanceColor) this.zgMesh.instanceColor.needsUpdate = true;
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
