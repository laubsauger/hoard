// T17 / V17 — modular anatomical segmentation + dismemberment.
// Dismemberment is MODULAR segment + wound-cap geometry, NOT runtime mesh cutting (V17). Each
// detachable region declares: bone ownership, render ownership (submesh/node), a sever threshold
// scale, a wound-cap asset and a detached-part asset, plus its behaviour consequence class. Sever
// state lives in the SoA `anatomyFlags` u32 bitfield (frozen layout) — encoded by `regionBit`.
// Missing limbs change attacks / locomotion / balance / crawling / reach / threat. Detached parts
// are POOLED: active for a short window, then settle to a cheap static prop (V17 / V18).

import type { AnatomyRegion, EntityId } from '@/game/core/contracts';
import { ANATOMY_REGIONS, isSeverable, isFatalRegion, regionBit } from './anatomy';

/** Posture is derived from sever state — it is not stored, it is computed (V17). */
export enum Posture {
  Standing = 0,
  Crawling = 1,
  Down = 2,
}

/**
 * Authored metadata for one anatomical segment. This is DATA (no behaviour) — bone + render
 * ownership let the render lane swap a wound cap / spawn a detached part without runtime cutting.
 */
export interface AnatomySegment {
  readonly region: AnatomyRegion;
  /** Skeleton bone that owns this segment (drives skinning + detach pivot). */
  readonly bone: string;
  /** Render node / submesh that owns this segment's geometry (drives wound-cap swap). */
  readonly renderNode: string;
  /** Can this region be severed in ordinary combat? (torso never severs — V17). */
  readonly severable: boolean;
  /** Head/neck destruction is the fatal class unless an archetype overrides (V17). */
  readonly fatal: boolean;
  /** Wound-cap geometry shown when this segment is severed (authored asset key). */
  readonly woundCapAsset: string;
  /** Detached-part geometry pooled as a settling prop after a sever (authored asset key). */
  readonly detachedPartAsset: string;
}

/** Stable bone/render ownership per region. Order mirrors ANATOMY_REGIONS. */
const SEGMENT_META: Readonly<Record<AnatomyRegion, { bone: string; renderNode: string }>> = {
  head: { bone: 'head', renderNode: 'mesh.head' },
  neck: { bone: 'neck', renderNode: 'mesh.neck' },
  torsoUpper: { bone: 'spine_upper', renderNode: 'mesh.torsoUpper' },
  torsoLower: { bone: 'spine_lower', renderNode: 'mesh.torsoLower' },
  armLeft: { bone: 'upperarm_L', renderNode: 'mesh.armLeft' },
  armRight: { bone: 'upperarm_R', renderNode: 'mesh.armRight' },
  legLeft: { bone: 'thigh_L', renderNode: 'mesh.legLeft' },
  legRight: { bone: 'thigh_R', renderNode: 'mesh.legRight' },
};

/** Build the default modular segment set. Archetypes compose/override this (T21). */
export function buildSegments(): Readonly<Record<AnatomyRegion, AnatomySegment>> {
  const out = {} as Record<AnatomyRegion, AnatomySegment>;
  for (const region of ANATOMY_REGIONS) {
    const meta = SEGMENT_META[region];
    out[region] = {
      region,
      bone: meta.bone,
      renderNode: meta.renderNode,
      severable: isSeverable(region),
      fatal: isFatalRegion(region),
      woundCapAsset: `woundcap.${region}`,
      detachedPartAsset: `part.${region}`,
    };
  }
  return out;
}

// ---- sever-state queries over the anatomyFlags bitfield ----

export function severedCount(anatomyFlags: number, regions: readonly AnatomyRegion[]): number {
  let n = 0;
  for (const r of regions) if ((anatomyFlags & regionBit(r)) !== 0) n += 1;
  return n;
}

const ARMS: readonly AnatomyRegion[] = ['armLeft', 'armRight'];
const LEGS: readonly AnatomyRegion[] = ['legLeft', 'legRight'];

/** Tunables read by the consequence calculation (subset of the combat config). */
export interface ConsequenceConfig {
  readonly armLossLocomotionPenalty: number;
  readonly legLossLocomotionPenalty: number;
  readonly armLossThreatPenalty: number;
  readonly legsLostToCrawl: number;
}

/** Behaviour consequences of the current sever state (V17). Pure function of flags + config. */
export interface LimbConsequences {
  /** Locomotion-speed scale in [0,1] (legs dominate, arms add balance cost). */
  readonly locomotionScale: number;
  /** Threat scale in [0,1] (each missing arm reduces reach/attack capability). */
  readonly threatScale: number;
  /** Derived posture — too many legs gone forces a crawl (V17). */
  readonly posture: Posture;
  /** Can the entity still perform a standing melee attack (needs at least one arm)? */
  readonly canAttack: boolean;
  /** Missing-limb counts (diagnostics / render). */
  readonly armsLost: number;
  readonly legsLost: number;
}

export function limbConsequences(anatomyFlags: number, cfg: ConsequenceConfig): LimbConsequences {
  const armsLost = severedCount(anatomyFlags, ARMS);
  const legsLost = severedCount(anatomyFlags, LEGS);

  const locomotionScale = clamp01(
    1 - legsLost * cfg.legLossLocomotionPenalty - armsLost * cfg.armLossLocomotionPenalty,
  );
  const threatScale = clamp01(1 - armsLost * cfg.armLossThreatPenalty);
  const posture = legsLost >= cfg.legsLostToCrawl ? Posture.Crawling : Posture.Standing;
  const canAttack = armsLost < ARMS.length;

  return { locomotionScale, threatScale, posture, canAttack, armsLost, legsLost };
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// ---- detached-part pool (V17 / V18) ----

/** A pooled detached-part handle. Active for a short window, then settles to a cheap static prop. */
export interface DetachedPart {
  readonly handle: number;
  entity: EntityId;
  region: AnatomyRegion;
  x: number;
  y: number;
  z: number;
  bornTick: number;
  /** False = active (physics-ish); true = settled cheap static prop (V18). */
  settled: boolean;
  /** False = handle is in the free pool, not representing a live part. */
  live: boolean;
}

/**
 * Bounded pool of detached-part handles. `detach` reuses a free/oldest handle (pooling, never an
 * unbounded allocation — V18). `update(tick)` settles parts past the active window. Same state can
 * later feed render/collision/save without becoming a per-part rigid body (V18).
 */
export class DetachedPartPool {
  private readonly parts: DetachedPart[] = [];
  private readonly capacity: number;
  private readonly settleTicks: number;
  private nextHandle = 0;

  constructor(opts: { capacity: number; settleTicks: number }) {
    if (!Number.isInteger(opts.capacity) || opts.capacity <= 0) {
      throw new Error(`DetachedPartPool capacity must be a positive integer, got ${opts.capacity}`);
    }
    if (!Number.isInteger(opts.settleTicks) || opts.settleTicks <= 0) {
      throw new Error(`DetachedPartPool settleTicks must be a positive integer, got ${opts.settleTicks}`);
    }
    this.capacity = opts.capacity;
    this.settleTicks = opts.settleTicks;
  }

  get activeCount(): number {
    return this.parts.reduce((n, p) => (p.live && !p.settled ? n + 1 : n), 0);
  }

  get settledCount(): number {
    return this.parts.reduce((n, p) => (p.live && p.settled ? n + 1 : n), 0);
  }

  get liveCount(): number {
    return this.parts.reduce((n, p) => (p.live ? n + 1 : n), 0);
  }

  /** Spawn a detached part. Reuses a free slot, else the oldest settled, else the oldest part. */
  detach(entity: EntityId, region: AnatomyRegion, x: number, y: number, z: number, tick: number): DetachedPart {
    const slot = this.acquire();
    slot.entity = entity;
    slot.region = region;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.bornTick = tick;
    slot.settled = false;
    slot.live = true;
    return slot;
  }

  /** Settle every active part whose active window has elapsed (cheap static prop afterwards). */
  update(tick: number): void {
    for (const p of this.parts) {
      if (p.live && !p.settled && tick - p.bornTick >= this.settleTicks) {
        p.settled = true;
      }
    }
  }

  /** Live (active + settled) parts — render/save read this; it never holds raw entity refs (V26: EntityId). */
  liveParts(): readonly DetachedPart[] {
    return this.parts.filter((p) => p.live);
  }

  private acquire(): DetachedPart {
    // 1. a free handle
    for (const p of this.parts) if (!p.live) return p;
    // 2. grow until capacity
    if (this.parts.length < this.capacity) {
      const p: DetachedPart = {
        handle: this.nextHandle++,
        entity: 0 as EntityId,
        region: 'head',
        x: 0,
        y: 0,
        z: 0,
        bornTick: 0,
        settled: false,
        live: false,
      };
      this.parts.push(p);
      return p;
    }
    // 3. recycle the oldest settled, else the oldest part (pooling under pressure — bounded, V18).
    let victim: DetachedPart | undefined;
    for (const p of this.parts) {
      if (!p.settled) continue;
      if (!victim || p.bornTick < victim.bornTick) victim = p;
    }
    if (!victim) {
      for (const p of this.parts) if (!victim || p.bornTick < victim.bornTick) victim = p;
    }
    return victim!;
  }
}
