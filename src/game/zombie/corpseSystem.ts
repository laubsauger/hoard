// T54 / B9 / V18 — CorpseSystem: persistent corpse records left by killed zombies.
// A killed zombie does NOT pop out of existence: combat's death transition captures a compact corpse
// record (last transform + archetype + severed-region flags) BEFORE the SoA sim slot is freed, then the
// slot is recycled (the corpse is cheap state, not an active sim entity). Corpses are pooled + capped and
// linger for a long, configured lifetime before cleanup (V4 — capacity/lifetime are typed config, never
// literals). Dismemberment consequences (missing limbs, via the anatomyFlags sever bitfield) ride along on
// the corpse so a body that lost a leg keeps that loss. Corpses persist through save/reload via the §I
// `corpses` save-delta category (V9) — captured/restored through this system.

import { resolveDomain } from '@/config/registry';
import { zombiesConfig } from '@/config/domains/zombies';
import type { QualityTier } from '@/config/types';
import type { CorpseRecord } from '@/game/persistence';

const REFERENCE_TIER: QualityTier = 'desktop-high';

/** Input captured at the moment of death (the killed zombie's last authoritative state). */
export interface CorpseSpawn {
  /** Stable EntityId of the zombie that died (cross-boundary id, never a raw slot — V26). */
  readonly entity: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  readonly archetype: number;
  /** anatomyFlags sever bitfield at death — which regions were dismembered (V17 consequence persists). */
  readonly severedFlags: number;
  /** Absolute tick the zombie died (drives lifetime expiry; survives reload via the runtime tick offset). */
  readonly bornTick: number;
}

/** A live corpse record. Mutated in place (pooled) — treat as read-only when consumed by the render lane. */
export interface Corpse {
  entity: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  archetype: number;
  severedFlags: number;
  bornTick: number;
}

export interface CorpseSettings {
  readonly capacity: number;
  readonly lifetimeTicks: number;
}

/** Resolve the corpse pool capacity + lifetime for a tier (V4 — both are typed config, not literals). */
export function resolveCorpseSettings(tier: QualityTier = REFERENCE_TIER): CorpseSettings {
  const z = resolveDomain(zombiesConfig, tier);
  return { capacity: z.corpseCapacity, lifetimeTicks: z.corpseLifetimeTicks };
}

function blankCorpse(): Corpse {
  return { entity: -1, x: 0, y: 0, z: 0, heading: 0, archetype: 0, severedFlags: 0, bornTick: 0 };
}

/**
 * Owns the live corpse records. The `live` array is ordered oldest -> newest by `bornTick` (game time only
 * advances, and we always append the newest), so the corpse lifetime is uniform and expired corpses form a
 * leading prefix — `prune` just drops from the front. When the pool is full a new corpse recycles the OLDEST
 * record object (no per-death allocation after warm-up — V24). The render lane reads `list` (V2 — render
 * consumes sim authority, never the reverse).
 */
export class CorpseSystem {
  readonly settings: CorpseSettings;
  private readonly live: Corpse[] = [];
  private readonly pool: Corpse[] = [];

  constructor(settings: CorpseSettings = resolveCorpseSettings()) {
    if (!Number.isInteger(settings.capacity) || settings.capacity <= 0) {
      throw new Error(`CorpseSystem capacity must be a positive integer, got ${settings.capacity}`);
    }
    if (!Number.isInteger(settings.lifetimeTicks) || settings.lifetimeTicks <= 0) {
      throw new Error(`CorpseSystem lifetimeTicks must be a positive integer, got ${settings.lifetimeTicks}`);
    }
    this.settings = settings;
  }

  /** Number of corpses currently lingering. */
  get count(): number {
    return this.live.length;
  }

  /** The live corpse records, oldest first. Read-only for consumers (render mirrors these — V2). */
  get list(): readonly Corpse[] {
    return this.live;
  }

  /** Record a corpse at a killed zombie's last transform. Capped; recycles the OLDEST record when full. */
  spawn(s: CorpseSpawn): Corpse {
    let rec: Corpse;
    if (this.live.length >= this.settings.capacity) {
      rec = this.live.shift()!; // recycle the oldest (front = oldest under uniform lifetime)
    } else {
      rec = this.pool.pop() ?? blankCorpse();
    }
    rec.entity = s.entity;
    rec.x = s.x;
    rec.y = s.y;
    rec.z = s.z;
    rec.heading = s.heading;
    rec.archetype = s.archetype;
    rec.severedFlags = s.severedFlags;
    rec.bornTick = s.bornTick;
    this.live.push(rec);
    return rec;
  }

  /** Drop corpses older than the configured lifetime. Returns how many were cleaned up. */
  prune(nowTick: number): number {
    const max = this.settings.lifetimeTicks;
    let removed = 0;
    while (this.live.length > 0 && nowTick - this.live[0]!.bornTick >= max) {
      this.pool.push(this.live.shift()!);
      removed += 1;
    }
    return removed;
  }

  /** Serialize the live corpses to compact persistence records (V9 — the §I `corpses` save-delta category). */
  capture(): CorpseRecord[] {
    return this.live.map((c) => ({
      entity: c.entity,
      x: c.x,
      z: c.z,
      atTick: c.bornTick,
      y: c.y,
      heading: c.heading,
      archetype: c.archetype,
      severedFlags: c.severedFlags,
    }));
  }

  /** Rehydrate from persistence records (V9), replacing the current set. Older saves default the additive
   *  fields (no invented gameplay — V4); the body is reconstructed exactly where it fell. */
  restore(records: readonly CorpseRecord[]): void {
    this.clear();
    for (const r of records) {
      this.spawn({
        entity: r.entity,
        x: r.x,
        y: r.y ?? 0,
        z: r.z,
        heading: r.heading ?? 0,
        archetype: r.archetype ?? 0,
        severedFlags: r.severedFlags ?? 0,
        bornTick: r.atTick,
      });
    }
  }

  /** Drop every corpse (records return to the pool for reuse). */
  clear(): void {
    while (this.live.length > 0) this.pool.push(this.live.pop()!);
  }
}
