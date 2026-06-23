// B7 — combat feedback. The render lane built GoreSystem + the VisualEvent contract but the live path
// never consumed runtime.pollEvents(), so firing produced NO muzzle flash, tracer, blood, sever or hit
// feedback. This module closes that gap: a PURE CombatFeedbackSystem ingests the drained VisualEvent
// stream (feeding the pooled, capped GoreSystem) + the player's fire action, and a thin GPU
// CombatFeedbackView reflects that state into instanced blood/spark batches + a muzzle light + a tracer.
//
// B14/T71 (V48): hit gore is no longer one giant axis-aligned quad. `energy` is clamped to its contract
// range [0,1] at ingest (a raw-damage value silently scaled the quad to meters). Each hit emits MULTIPLE
// small billboarded blood droplets from the struck region's WORLD HEIGHT, launched along the impact vector
// with lateral spread + an upward arc and settled by gravity over their lifetime, plus a persistent
// flattened ground splat at the projected impact point. Energy now only modulates count/spread/size.
//
// B15/T74 (V49): the tracer terminates at the shot's actual stop distance — the struck body's travel
// (or max range on a clean miss) — never drawn through bodies to max range, with an impact spark at the
// stop point.
//
// Everything is pooled + capped (no per-shot allocation) and gore-intensity / reduce-flashes accessibility
// is respected (V29). The system is GPU-free so the ingest/aging logic is unit-tested without a device.

import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
} from 'three';
import type { AnatomyRegion, VisualEvent } from '../../game/core/contracts/events';
import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import { GoreSystem, resolveGoreSettings, type GoreParticle, type GoreSettings } from './gore';

const MUZZLE_COLOR = 0xffd9a0;
const TRACER_COLOR = 0xfff2c4;
const SPARK_COLOR = 0xffe6b0;

/** Clamp an out-of-contract value into [0,1] (defensive contract enforcement per V48 — NOT a fallback). */
export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Spawn-height map for the three anatomical bands (V48). Heights are above the struck body's base. */
export interface RegionHeights {
  readonly head: number;
  readonly torso: number;
  readonly leg: number;
}

/** Map a struck region to its blood-emission world height (V48). No magic numbers — bands come from config. */
export function regionImpactHeight(region: AnatomyRegion, h: RegionHeights): number {
  switch (region) {
    case 'head':
    case 'neck':
      return h.head;
    case 'torsoUpper':
    case 'torsoLower':
    case 'armLeft':
    case 'armRight':
      return h.torso;
    case 'legLeft':
    case 'legRight':
      return h.leg;
  }
}

export interface SprayBallistics {
  readonly velocityMps: number;
  readonly upwardMps: number;
  readonly spreadMps: number;
  readonly gravityMps2: number;
}

/** Deterministic [0,1) hash so per-droplet spread is stable frame-to-frame (no per-frame allocation/random). */
function hash01(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

/**
 * Ballistic offset (relative to the spawn point) of one blood droplet at `ageSeconds` (V48). The droplet
 * is launched ALONG the normalized impact vector (dirX,dirZ) with a deterministic per-droplet forward
 * scale, a lateral spread perpendicular to the impact, and an upward arc; gravity settles it over time.
 */
export function sprayParticleOffset(
  seq: number,
  index: number,
  ageSeconds: number,
  dirX: number,
  dirZ: number,
  b: SprayBallistics,
): { x: number; y: number; z: number } {
  const hLat = hash01(seq * 131 + index * 17) * 2 - 1; // [-1,1] lateral
  const hFwd = hash01(seq * 977 + index * 53); // [0,1]
  const hUp = hash01(seq * 769 + index * 29); // [0,1]
  const fwd = b.velocityMps * (0.5 + 0.5 * hFwd);
  const lat = b.spreadMps * hLat;
  const up = b.upwardMps * (0.6 + 0.4 * hUp);
  // perpendicular to (dirX,dirZ) in the XZ plane is (-dirZ, dirX).
  const vx = dirX * fwd + -dirZ * lat;
  const vz = dirZ * fwd + dirX * lat;
  return {
    x: vx * ageSeconds,
    y: up * ageSeconds - 0.5 * b.gravityMps2 * ageSeconds * ageSeconds,
    z: vz * ageSeconds,
  };
}

export interface CombatFeedbackSettings {
  readonly gore: GoreSettings;
  readonly sparkLifetimeSeconds: number;
  readonly muzzleFlashSeconds: number;
  readonly tracerSeconds: number;
  readonly muzzleFlashIntensity: number;
  readonly tracerRangeMeters: number;
  /** Forward offset (m) from the player body centre to the weapon muzzle along the aim vector (B20-muzzle/V55, T78). */
  readonly muzzleOffsetMeters: number;
  // B14/T71 gore overhaul (V48)
  readonly sprayParticleSizeMeters: number;
  readonly sprayBallistics: SprayBallistics;
  readonly stainSizeMeters: number;
  readonly stainLifetimeSeconds: number;
  readonly regionHeights: RegionHeights;
}

export function resolveCombatFeedbackSettings(tier: QualityTier): CombatFeedbackSettings {
  return {
    gore: resolveGoreSettings(tier),
    sparkLifetimeSeconds: resolve(renderingConfig.combatSparkLifetimeSeconds, tier),
    muzzleFlashSeconds: resolve(renderingConfig.combatMuzzleFlashSeconds, tier),
    tracerSeconds: resolve(renderingConfig.combatTracerSeconds, tier),
    muzzleFlashIntensity: resolve(renderingConfig.combatMuzzleFlashIntensity, tier),
    tracerRangeMeters: resolve(renderingConfig.combatTracerRangeMeters, tier),
    muzzleOffsetMeters: resolve(renderingConfig.combatMuzzleOffsetMeters, tier),
    sprayParticleSizeMeters: resolve(renderingConfig.combatGoreSprayParticleSizeMeters, tier),
    sprayBallistics: {
      velocityMps: resolve(renderingConfig.combatGoreSprayVelocityMps, tier),
      upwardMps: resolve(renderingConfig.combatGoreSprayUpwardMps, tier),
      spreadMps: resolve(renderingConfig.combatGoreSpraySpreadMps, tier),
      gravityMps2: resolve(renderingConfig.combatGoreSprayGravityMps2, tier),
    },
    stainSizeMeters: resolve(renderingConfig.combatGoreStainSizeMeters, tier),
    stainLifetimeSeconds: resolve(renderingConfig.combatGoreStainLifetimeSeconds, tier),
    regionHeights: {
      head: resolve(renderingConfig.combatGoreHeightHeadMeters, tier),
      torso: resolve(renderingConfig.combatGoreHeightTorsoMeters, tier),
      leg: resolve(renderingConfig.combatGoreHeightLegMeters, tier),
    },
  };
}

/** A timed one-shot effect (muzzle flash / tracer). Lives until age reaches ttl. */
interface Pulse {
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirZ: number;
  age: number;
  ttl: number;
  /** Tracer-only: distance from the muzzle at which the beam terminates (V49). */
  stopDistance: number;
  /** True when stopDistance came from an explicit fire() argument (wins over impact-derived). */
  stopExplicit: boolean;
}

export interface IngestContext {
  /** Camera world position — gore is simplified beyond goreDistantSimplifyMeters (V8). */
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cameraZ: number;
  /** Gore-intensity accessibility multiplier 0..1 (V29). 0 fully suppresses gore. */
  readonly goreIntensity: number;
}

/**
 * Pure combat-feedback state. Owns the pooled GoreSystem and the timed muzzle/tracer pulses. No Three.js.
 *
 * Hit feedback comes from the sim's paired (hitReaction -> bloodSpray) emission: hitReaction carries the
 * impact energy + direction + struck REGION but no position, bloodSpray carries the world position. We pair
 * them in emission order so a positioned, energy-weighted directional spray + a ground splat are spawned per
 * hit. partDetached adds a sever marker at the last impact. soundEmitted is not gore.
 */
export class CombatFeedbackSystem {
  readonly gore: GoreSystem;
  private readonly settings: CombatFeedbackSettings;
  private muzzle: Pulse | null = null;
  private tracer: Pulse | null = null;
  private pending: { energy: number; dirX: number; dirZ: number; region: AnatomyRegion } | null = null;
  private lastImpact: { x: number; y: number; z: number } | null = null;

  constructor(settings: CombatFeedbackSettings) {
    this.settings = settings;
    this.gore = new GoreSystem(settings.gore);
  }

  /**
   * Player fired — flash the muzzle + draw a tracer from the muzzle along the aim direction (B7). The
   * caller passes the player BODY position (x,y,z); T78/V55 offsets the origin FORWARD along the normalized
   * aim by `muzzleOffsetMeters` so the flash / tracer / impact spark originate at the weapon muzzle = body +
   * aim*offset (in FRONT of the player), never at the body centre/back (which made the beam travel through
   * the body before exiting). The tracer terminates at `stopDistanceMeters` (the struck body's travel, V49)
   * when supplied; otherwise it defaults to the clean-miss max range and may still be refined by an
   * impact-coincident bloodSpray during ingest.
   */
  fire(x: number, y: number, z: number, dirX: number, dirZ: number, stopDistanceMeters?: number): void {
    const len = Math.hypot(dirX, dirZ) || 1;
    const nx = dirX / len;
    const nz = dirZ / len;
    // Muzzle = player centre pushed forward along the aim vector (B20-muzzle/V55).
    const ox = x + nx * this.settings.muzzleOffsetMeters;
    const oz = z + nz * this.settings.muzzleOffsetMeters;
    const range = this.settings.tracerRangeMeters;
    const explicit = stopDistanceMeters !== undefined && Number.isFinite(stopDistanceMeters) && stopDistanceMeters > 0;
    const stop = explicit ? Math.min(stopDistanceMeters, range) : range;
    this.muzzle = { x: ox, y, z: oz, dirX: nx, dirZ: nz, age: 0, ttl: this.settings.muzzleFlashSeconds, stopDistance: stop, stopExplicit: explicit };
    this.tracer = { x: ox, y, z: oz, dirX: nx, dirZ: nz, age: 0, ttl: this.settings.tracerSeconds, stopDistance: stop, stopExplicit: explicit };
  }

  /** Consume one frame's drained VisualEvents, feeding the pooled GoreSystem (B7). */
  ingest(events: readonly VisualEvent[], ctx: IngestContext): void {
    for (const e of events) {
      switch (e.kind) {
        case 'hitReaction':
          // Position-less: remember the clamped impact energy/direction/region for the paired bloodSpray.
          // V48/B14: energy is contract-normalized 0..1 — clamp defensively (a raw-damage value scales gore to meters).
          this.pending = { energy: clamp01(e.energy), dirX: e.dirX, dirZ: e.dirZ, region: e.region };
          break;
        case 'bloodSpray': {
          const dist = Math.hypot(e.x - ctx.cameraX, e.y - ctx.cameraY, e.z - ctx.cameraZ);
          const rec = this.gore.ingest(e, dist, ctx.goreIntensity);
          this.lastImpact = { x: e.x, y: e.y, z: e.z };
          const hitEnergy = this.pending ? this.pending.energy : 1;
          if (rec && this.pending) {
            // Inherit the hit's clamped energy + struck region (gore-intensity already applied to energy).
            rec.energy = this.pending.energy * ctx.goreIntensity;
            rec.region = this.pending.region;
          }
          // Persistent flattened ground splat at the projected impact point (V48).
          this.gore.spawnStain(e.x, e.z, hitEnergy, dist, ctx.goreIntensity);
          // V49: terminate the live tracer at this impact when it is the shot's struck body.
          this.applyTracerStopFromImpact(e.x, e.z);
          this.pending = null;
          break;
        }
        case 'partDetached': {
          const at = this.lastImpact;
          const dist = at ? Math.hypot(at.x - ctx.cameraX, at.y - ctx.cameraY, at.z - ctx.cameraZ) : 0;
          const rec = this.gore.ingest(e, dist, ctx.goreIntensity);
          if (rec && at) {
            rec.x = at.x;
            rec.y = at.y;
            rec.z = at.z;
          }
          break;
        }
        case 'soundEmitted':
          break; // not gore.
      }
    }
  }

  /** Terminate the active tracer at a struck-body impact (V49) unless an explicit stop was already supplied. */
  private applyTracerStopFromImpact(x: number, z: number): void {
    const t = this.tracer;
    if (!t || t.stopExplicit) return;
    const proj = (x - t.x) * t.dirX + (z - t.z) * t.dirZ; // distance along the aim toward the impact
    if (proj <= 0) return; // behind the muzzle — not this shot.
    t.stopDistance = Math.min(proj, this.settings.tracerRangeMeters);
  }

  /** Advance timed pulses + age the gore pools, recycling expired records (B7). */
  update(dtSeconds: number): void {
    if (dtSeconds < 0) throw new Error(`dtSeconds must be non-negative, got ${dtSeconds}`);
    if (this.muzzle) {
      this.muzzle.age += dtSeconds;
      if (this.muzzle.age >= this.muzzle.ttl) this.muzzle = null;
    }
    if (this.tracer) {
      this.tracer.age += dtSeconds;
      if (this.tracer.age >= this.tracer.ttl) this.tracer = null;
    }
    this.gore.update(dtSeconds, this.settings.sparkLifetimeSeconds, this.settings.stainLifetimeSeconds);
  }

  /** Muzzle-flash brightness 0..1 (linear fade over its ttl), or 0 if inactive. */
  muzzleIntensity01(): number {
    return this.muzzle ? Math.max(0, 1 - this.muzzle.age / this.muzzle.ttl) : 0;
  }

  /** Tracer opacity 0..1 (linear fade over its ttl), or 0 if inactive. */
  tracerAlpha01(): number {
    return this.tracer ? Math.max(0, 1 - this.tracer.age / this.tracer.ttl) : 0;
  }

  /** Distance from the muzzle at which the active tracer terminates (V49), or 0 if inactive. */
  tracerStopDistance(): number {
    return this.tracer ? this.tracer.stopDistance : 0;
  }

  get muzzlePulse(): Readonly<Pulse> | null {
    return this.muzzle;
  }
  get tracerPulse(): Readonly<Pulse> | null {
    return this.tracer;
  }

  /** Active blood/impact spray records (renderer expands each into billboarded droplets). */
  get sprayRecords(): readonly GoreParticle[] {
    return this.gore.activeRecords('spray');
  }
  /** Active persistent ground splats. */
  get stainRecords(): readonly GoreParticle[] {
    return this.gore.activeRecords('stain');
  }
  /** Active sever markers. */
  get severRecords(): readonly GoreParticle[] {
    return this.gore.activeRecords('sever');
  }

  get config(): CombatFeedbackSettings {
    return this.settings;
  }

  /** Normalized age fade 0..1 for a spray/sever record (1 fresh, 0 expired). */
  recordFade(rec: GoreParticle): number {
    return Math.max(0, 1 - rec.age / this.settings.sparkLifetimeSeconds);
  }

  /** Normalized age fade 0..1 for a persistent ground splat (longer lifetime than sparks). */
  stainFade(rec: GoreParticle): number {
    return Math.max(0, 1 - rec.age / this.settings.stainLifetimeSeconds);
  }
}

/**
 * GPU side of combat feedback (V24-tracked) — T74 muzzle / tracer / impact-spark ONLY. The blood spray +
 * ground splat that this view used to render are RETIRED here: the pooled BloodView (T75/V51) + GibView
 * (T76/V52) now own all blood + gibs, so rendering gore here too would double it. The pure
 * CombatFeedbackSystem still ingests bloodSpray to terminate the tracer at the struck-body impact (V49).
 *
 * The muzzle is a short-lived point light + emissive bead; the tracer is one reused box terminating at the
 * shot's stop distance with an impact-spark bead. Nothing is allocated per shot. sync() mirrors state each frame.
 */
export class CombatFeedbackView {
  private readonly tracerMesh: Mesh;
  private readonly muzzleLight: PointLight;
  private readonly muzzleBead: Mesh;
  private readonly impactSpark: Mesh;
  private readonly settings: CombatFeedbackSettings;

  constructor(settings: CombatFeedbackSettings, registry: ResourceRegistry) {
    this.settings = settings;

    // ---- tracer ----
    const tracerGeo = registry.track(new BoxGeometry(1, 0.03, 0.03), 'geometry', 'combat.tracerGeo');
    const tracerMat = registry.track(
      new MeshBasicMaterial({ name: 'combat.tracer', color: TRACER_COLOR, transparent: true, opacity: 0, depthWrite: false }),
      'material',
      'combat.tracerMat',
    );
    this.tracerMesh = new Mesh(tracerGeo, tracerMat);
    this.tracerMesh.visible = false;
    this.tracerMesh.renderOrder = 2;

    // ---- muzzle flash ----
    this.muzzleLight = new PointLight(MUZZLE_COLOR, 0, settings.tracerRangeMeters * 0.5);
    // Stays in the scene PERMANENTLY at intensity 0 (visible never toggles) so firing never changes the
    // visible-light count → no per-shot lighting-state rebuild / pipeline recompile (V61). Driven by intensity.
    this.muzzleLight.visible = true;

    const beadGeo = registry.track(new PlaneGeometry(0.5, 0.5), 'geometry', 'combat.muzzleBeadGeo');
    const beadMat = registry.track(
      new MeshBasicMaterial({ name: 'combat.muzzleBead', color: MUZZLE_COLOR, transparent: true, opacity: 0, depthWrite: false }),
      'material',
      'combat.muzzleBeadMat',
    );
    this.muzzleBead = new Mesh(beadGeo, beadMat);
    this.muzzleBead.visible = false;
    this.muzzleBead.renderOrder = 2;

    // ---- impact spark at the tracer stop point (V49) ----
    const sparkGeo = registry.track(new PlaneGeometry(0.35, 0.35), 'geometry', 'combat.impactSparkGeo');
    const sparkMat = registry.track(
      new MeshBasicMaterial({ name: 'combat.impactSpark', color: SPARK_COLOR, transparent: true, opacity: 0, depthWrite: false }),
      'material',
      'combat.impactSparkMat',
    );
    this.impactSpark = new Mesh(sparkGeo, sparkMat);
    this.impactSpark.visible = false;
    this.impactSpark.renderOrder = 3;
  }

  /** Add the feedback objects to the scene graph (parent owns scene-graph membership, registry owns disposal). */
  attachTo(parent: Object3D): void {
    parent.add(this.tracerMesh, this.muzzleLight, this.muzzleBead, this.impactSpark);
  }

  /** Mirror the pure system's current state onto the GPU objects (B7). `reduceFlashes` suppresses the
   *  bright muzzle flash for the photosensitivity accessibility setting (V29) while keeping the tracer. */
  sync(system: CombatFeedbackSystem, reduceFlashes: boolean): void {
    // ---- muzzle flash ----
    const flash = reduceFlashes ? 0 : system.muzzleIntensity01();
    const m = system.muzzlePulse;
    if (m && flash > 0) {
      this.muzzleLight.position.set(m.x, m.y, m.z);
      this.muzzleLight.intensity = flash * this.settings.muzzleFlashIntensity;
      this.muzzleBead.position.set(m.x, m.y, m.z);
      // Orient the flash along the aim (lie it flat on the fire plane, spin to the shot heading) so it tracks
      // where the weapon points instead of a fixed static rotation (V55). Matches the tracer's heading.
      this.muzzleBead.rotation.set(-Math.PI / 2, 0, -Math.atan2(-m.dirZ, m.dirX));
      (this.muzzleBead.material as MeshBasicMaterial).opacity = flash;
      this.muzzleBead.visible = true;
    } else {
      // PERF (V61): NEVER toggle the muzzle light's `.visible` — flipping a light in/out of the scene changes
      // the renderer's visible-light count, which rebuilds the lighting state + recompiles EVERY material's
      // pipeline. Under WebGPU that pipeline recompile stalls for several frames — a freeze on every shot. The
      // light stays in the scene permanently; intensity 0 = no contribution, no recompile. (Meshes are exempt —
      // mesh `.visible` does not affect the lights hash — so the bead toggle below is fine.)
      this.muzzleLight.intensity = 0;
      this.muzzleBead.visible = false;
    }

    // ---- tracer: stretch the reused box from the muzzle to the shot's stop distance only (V49) ----
    const t = system.tracerPulse;
    const alpha = system.tracerAlpha01();
    if (t && alpha > 0) {
      const stop = system.tracerStopDistance();
      this.tracerMesh.position.set(t.x + t.dirX * stop * 0.5, t.y, t.z + t.dirZ * stop * 0.5);
      this.tracerMesh.scale.set(Math.max(0.001, stop), 1, 1);
      this.tracerMesh.rotation.set(0, Math.atan2(-t.dirZ, t.dirX), 0);
      (this.tracerMesh.material as MeshBasicMaterial).opacity = alpha;
      this.tracerMesh.visible = true;
      // impact spark marks where the shot actually stopped.
      this.impactSpark.position.set(t.x + t.dirX * stop, t.y, t.z + t.dirZ * stop);
      (this.impactSpark.material as MeshBasicMaterial).opacity = alpha;
      this.impactSpark.visible = true;
    } else {
      this.tracerMesh.visible = false;
      this.impactSpark.visible = false;
    }
  }
}
