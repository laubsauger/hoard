// T19 / V8 / V29 — gore render. Consumes the frozen VisualEvent stream (hitReaction / bloodSpray /
// partDetached) and produces POOLED, CAPPED gore: directional blood spray/mist (impact direction +
// weapon energy), readable persistent stains, sever silhouettes. Distant gore is pooled+simplified;
// rare hero moments get the full wet response. Respects a gore-intensity accessibility setting (V29):
// 0 fully suppresses, 1 is full. Pure logic (no GPU); the InstancedMesh owner is GoreRenderer (V24).

import { InstancedMesh, PlaneGeometry, MeshBasicMaterial } from 'three';
import type { VisualEvent } from '../../game/core/contracts/events';
import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';

export type GoreKind = 'spray' | 'stain' | 'sever';

/** One pooled gore record. Reused in place (no allocation in the hot path). */
export interface GoreParticle {
  active: boolean;
  kind: GoreKind;
  x: number;
  y: number;
  z: number;
  /** Normalized impact direction (spray/mist travel + sever fling). */
  dirX: number;
  dirZ: number;
  /** Spawn energy 0..1 (weapon energy / impact strength), already gore-intensity scaled. */
  energy: number;
  /** Particle count to render for this record (sprays), distance + intensity scaled. */
  particles: number;
  /** Monotonic spawn sequence — oldest (lowest) is recycled first when the pool is full. */
  seq: number;
  /** Seconds since spawn — drives fade-out + lifetime recycling in the renderer (B7). */
  age: number;
}

export interface GoreSettings {
  readonly sprayPoolSize: number;
  readonly stainPoolSize: number;
  readonly severPoolSize: number;
  readonly sprayParticlesPerEvent: number;
  readonly distantSimplifyMeters: number;
}

export function resolveGoreSettings(tier: QualityTier): GoreSettings {
  return {
    sprayPoolSize: resolve(renderingConfig.goreSprayPoolSize, tier),
    stainPoolSize: resolve(renderingConfig.goreStainPoolSize, tier),
    severPoolSize: resolve(renderingConfig.goreSeverPoolSize, tier),
    sprayParticlesPerEvent: resolve(renderingConfig.goreSprayParticlesPerEvent, tier),
    distantSimplifyMeters: resolve(renderingConfig.goreDistantSimplifyMeters, tier),
  };
}

/** A single fixed-capacity ring pool. When full, the oldest active record is recycled (V8 — capped). */
class GorePoolRing {
  readonly records: GoreParticle[];
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) throw new Error(`gore pool capacity must be a non-negative integer, got ${capacity}`);
    this.records = Array.from({ length: capacity }, () => ({
      active: false, kind: 'spray' as GoreKind, x: 0, y: 0, z: 0, dirX: 0, dirZ: 0, energy: 0, particles: 0, seq: 0, age: 0,
    }));
  }

  get capacity(): number { return this.records.length; }
  get activeCount(): number { return this.records.reduce((n, r) => n + (r.active ? 1 : 0), 0); }

  /** Acquire a slot: a free one if any, otherwise the oldest active record (recycled, never grown). */
  acquire(): GoreParticle | null {
    if (this.records.length === 0) return null;
    let free: GoreParticle | null = null;
    let oldest = this.records[0]!;
    for (const r of this.records) {
      if (!r.active) { free = r; break; }
      if (r.seq < oldest.seq) oldest = r;
    }
    return free ?? oldest;
  }
}

/**
 * Pure gore state machine. ingest() consumes ONE VisualEvent and either spawns a pooled record or
 * ignores it (non-gore events, or gore-intensity 0). Caps are hard: total active never exceeds the
 * configured pool size — the oldest record is recycled instead of allocating (V8). gore-intensity
 * (V29) scales energy + particle count and gates spawning entirely at 0.
 */
export class GoreSystem {
  private readonly spray: GorePoolRing;
  private readonly stain: GorePoolRing;
  private readonly sever: GorePoolRing;
  private seq = 0;

  constructor(private readonly settings: GoreSettings) {
    this.spray = new GorePoolRing(settings.sprayPoolSize);
    this.stain = new GorePoolRing(settings.stainPoolSize);
    this.sever = new GorePoolRing(settings.severPoolSize);
  }

  poolFor(kind: GoreKind): GorePoolRing {
    return kind === 'spray' ? this.spray : kind === 'stain' ? this.stain : this.sever;
  }

  activeCount(kind: GoreKind): number { return this.poolFor(kind).activeCount; }
  capacity(kind: GoreKind): number { return this.poolFor(kind).capacity; }

  /**
   * @param distanceMeters camera distance to the impact — beyond distantSimplifyMeters the spray uses
   *   the pooled simplified form (1 particle); near impacts get the full hero wet response.
   * @param goreIntensity accessibility multiplier 0..1 (V29). 0 => nothing spawns.
   * @returns the spawned record, or null if the event was not gore or was suppressed.
   */
  ingest(event: VisualEvent, distanceMeters: number, goreIntensity: number): GoreParticle | null {
    if (goreIntensity < 0 || goreIntensity > 1) throw new Error(`goreIntensity must be in [0,1], got ${goreIntensity}`);
    if (!Number.isFinite(distanceMeters) || distanceMeters < 0) throw new Error(`distanceMeters must be a non-negative finite number, got ${distanceMeters}`);
    if (goreIntensity === 0) return null; // V29 — fully suppressed, no gore at all.

    switch (event.kind) {
      case 'hitReaction':
        // Directional spray driven by impact direction + weapon energy.
        return this.spawn('spray', { x: 0, y: 0, z: 0, dirX: event.dirX, dirZ: event.dirZ, energy: event.energy }, distanceMeters, goreIntensity);
      case 'bloodSpray':
        return this.spawn('spray', { x: event.x, y: event.y, z: event.z, dirX: event.dirX, dirZ: event.dirZ, energy: 1 }, distanceMeters, goreIntensity);
      case 'partDetached':
        // Sever silhouette marker (the detached part itself is a pooled prop owned by sim/anatomy).
        return this.spawn('sever', { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0, energy: 1 }, distanceMeters, goreIntensity);
      default:
        return null; // soundEmitted etc. are not gore.
    }
  }

  private spawn(
    kind: GoreKind,
    p: { x: number; y: number; z: number; dirX: number; dirZ: number; energy: number },
    distanceMeters: number,
    goreIntensity: number,
  ): GoreParticle | null {
    const pool = this.poolFor(kind);
    const rec = pool.acquire();
    if (!rec) return null; // pool size 0 => effect disabled by config.

    const distant = distanceMeters > this.settings.distantSimplifyMeters;
    const baseParticles = kind === 'spray' ? this.settings.sprayParticlesPerEvent : 1;
    // Distant gore is simplified to a single pooled puff; near gore scales with intensity.
    const particles = distant ? 1 : Math.max(1, Math.round(baseParticles * goreIntensity));

    rec.active = true;
    rec.kind = kind;
    rec.x = p.x;
    rec.y = p.y;
    rec.z = p.z;
    rec.dirX = p.dirX;
    rec.dirZ = p.dirZ;
    rec.energy = p.energy * goreIntensity;
    rec.particles = particles;
    rec.seq = ++this.seq;
    rec.age = 0;
    return rec;
  }

  /** Retire a record back to the pool (e.g. after its lifetime elapses). */
  release(rec: GoreParticle): void {
    rec.active = false;
  }

  /**
   * Age every active record and recycle any that have outlived `lifetimeSeconds` (B7). Pure book-keeping
   * over the fixed pools — no allocation. Returns the number still active after the sweep.
   */
  update(dtSeconds: number, lifetimeSeconds: number): number {
    if (dtSeconds < 0) throw new Error(`dtSeconds must be non-negative, got ${dtSeconds}`);
    if (lifetimeSeconds <= 0) throw new Error(`lifetimeSeconds must be positive, got ${lifetimeSeconds}`);
    let active = 0;
    for (const kind of ['spray', 'stain', 'sever'] as const) {
      for (const r of this.poolFor(kind).records) {
        if (!r.active) continue;
        r.age += dtSeconds;
        if (r.age >= lifetimeSeconds) r.active = false;
        else active += 1;
      }
    }
    return active;
  }

  /** Active records of a kind (renderer reads these to lay out the instanced batch). */
  activeRecords(kind: GoreKind): readonly GoreParticle[] {
    return this.poolFor(kind).records.filter((r) => r.active);
  }
}

/**
 * GPU owner for gore — ONE shared InstancedMesh per pool kind, never per particle. Construction is
 * CPU-only and every resource is tracked for disposal (V24). Logic lives in GoreSystem; this just owns
 * the instanced batches the renderer writes into.
 */
export class GoreRenderer {
  readonly sprayBatch: InstancedMesh;
  readonly stainBatch: InstancedMesh;
  private readonly geometry: PlaneGeometry;
  private readonly material: MeshBasicMaterial;

  constructor(settings: GoreSettings, registry: ResourceRegistry) {
    this.geometry = registry.track(new PlaneGeometry(0.15, 0.15), 'geometry', 'gore.geometry');
    this.material = registry.track(new MeshBasicMaterial({ name: 'gore', transparent: true }), 'material', 'gore.material');
    this.sprayBatch = registry.track(
      new InstancedMesh(this.geometry, this.material, Math.max(1, settings.sprayPoolSize)),
      'buffer',
      'gore.sprayBatch',
    );
    this.sprayBatch.count = 0;
    this.stainBatch = registry.track(
      new InstancedMesh(this.geometry, this.material, Math.max(1, settings.stainPoolSize)),
      'buffer',
      'gore.stainBatch',
    );
    this.stainBatch.count = 0;
  }
}
