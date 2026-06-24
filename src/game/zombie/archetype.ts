// T21 / V7 / §I — `ZombieArchetype` data shape, composed from DATA (not subclasses).
// An archetype is a flat data record: behaviour, combat and locomotion systems read fields off it
// rather than branching on a class/type. Numeric tunables come from typed config (V4); categorical
// composition (body/skeleton family, locomotion kind, allowed tiers, sever rules) is authored data.
// `defineArchetype` validates the composed record — invalid content throws (V4/V7), never silent.

import type { AnatomyRegion } from '@/game/core/contracts';
import { SimTier } from '@/game/simulation';

export type BodyFamily = 'humanoid' | 'humanoid-heavy' | 'humanoid-light';
export type LocomotionKind = 'shamble' | 'run' | 'crawl';

/**
 * Gore palette key an archetype bleeds (V7 — authored categorical data, not a render concern).
 * The render gore system branches on this via its `goreColor(kind)` seam: `blood`/`ichor` are wet,
 * `burned` is a charred/ash response that emits little-to-no blood. Kept value-compatible with the
 * render-side `GoreType` so an archetype can ride a gore event unchanged once wired (note in report).
 */
export type GoreType = 'blood' | 'ichor' | 'burned';
const GORE_TYPES: ReadonlySet<GoreType> = new Set<GoreType>(['blood', 'ichor', 'burned']);

export interface LocomotionProfile {
  readonly kind: LocomotionKind;
  /** World meters per second at full health/anatomy (nominal; = baseline × `moveSpeedScale`). */
  readonly moveSpeed: number;
  /**
   * T124/V89 — the AUTHORITATIVE sim move-speed multiplier applied to the shared horde baseline
   * (`combat.hordeMoveSpeed`) for this archetype: effective tick speed = baseline × `moveSpeedScale`.
   * STANDARD = 1.0 (the baseline, unchanged); RUNNER > 1 (faster); BLOATED < 1 (slower). The movement step
   * reads it per slot via the archetype index, so a per-archetype speed actually takes effect in the sim.
   */
  readonly moveSpeedScale: number;
}

export interface PerceptionProfile {
  readonly sightRange: number;
  readonly hearingRange: number;
}

export interface AttackProfile {
  readonly damage: number;
  readonly rangeMeters: number;
  /** Seconds between consecutive attacks on a reached target (per-archetype cadence, V17). */
  readonly cooldownSeconds: number;
}

export interface AnatomyProfile {
  /** Scales the base sever threshold (anatomical damage variation per archetype). */
  readonly severThresholdScale: number;
  /** Regions that can be severed for this archetype (a crawler has no legs to lose). */
  readonly severableRegions: readonly AnatomyRegion[];
  /** Head/neck destruction fatal? (archetype may override the global head-kill default — V17). */
  readonly headFatal: boolean;
  /** Sever bits this archetype spawns with (e.g. a crawler spawns legless). */
  readonly initialAnatomyFlags: number;
}

export interface DurabilityProfile {
  readonly health: number;
  readonly armor: number;
}

export interface ZombieArchetype {
  readonly id: string;
  readonly bodyFamily: BodyFamily;
  readonly skeletonFamily: string;
  readonly locomotion: LocomotionProfile;
  readonly perception: PerceptionProfile;
  readonly attack: AttackProfile;
  readonly anatomy: AnatomyProfile;
  readonly durability: DurabilityProfile;
  /**
   * T124/V89 — relative SPAWN WEIGHT used by the deterministic weighted spawn pick. Higher = more common;
   * 0 = never spawned by the default mix (an authored ecology variant kept for tuning). STANDARD is dominant
   * (~70%+), BLOATED + RUNNER are sprinkled. A pure ratio, normalized against the roster's total at spawn.
   */
  readonly spawnWeight: number;
  /** Gore palette this archetype bleeds — the render gore system branches on it (V7 seam). */
  readonly gore: GoreType;
  /** Emits a burst death effect when killed (data flag only — render hooks on it later, V7). */
  readonly burstsOnDeath: boolean;
  /** Sim tiers this archetype may occupy (V13). */
  readonly allowedSimTiers: readonly SimTier[];
  /** Render tiers this archetype may occupy. */
  readonly allowedRenderTiers: readonly SimTier[];
}

/** Validate + freeze a composed archetype. Throws on invalid content (V4/V7 — no silent fallback). */
export function defineArchetype(a: ZombieArchetype): ZombieArchetype {
  if (!a.id) throw new Error('archetype id required');
  if (a.locomotion.moveSpeed <= 0) throw new Error(`archetype ${a.id}: moveSpeed must be > 0`);
  if (a.locomotion.moveSpeedScale <= 0) throw new Error(`archetype ${a.id}: moveSpeedScale must be > 0`);
  if (a.spawnWeight < 0) throw new Error(`archetype ${a.id}: spawnWeight must be >= 0`);
  if (a.durability.health <= 0) throw new Error(`archetype ${a.id}: health must be > 0`);
  if (a.durability.armor < 0) throw new Error(`archetype ${a.id}: armor must be >= 0`);
  if (a.perception.sightRange <= 0 || a.perception.hearingRange <= 0) {
    throw new Error(`archetype ${a.id}: perception ranges must be > 0`);
  }
  if (a.attack.rangeMeters <= 0) throw new Error(`archetype ${a.id}: attack range must be > 0`);
  if (a.attack.cooldownSeconds <= 0) throw new Error(`archetype ${a.id}: attack cooldown must be > 0`);
  if (a.anatomy.severThresholdScale <= 0) throw new Error(`archetype ${a.id}: severThresholdScale must be > 0`);
  if (!GORE_TYPES.has(a.gore)) throw new Error(`archetype ${a.id}: unknown gore type '${a.gore}'`);
  if (a.allowedSimTiers.length === 0) throw new Error(`archetype ${a.id}: needs >= 1 allowed sim tier`);
  if (a.allowedRenderTiers.length === 0) throw new Error(`archetype ${a.id}: needs >= 1 allowed render tier`);
  // crawler invariant: a crawl-locomotion archetype must not list legs as severable (already gone).
  if (a.locomotion.kind === 'crawl') {
    if (a.anatomy.severableRegions.includes('legLeft') || a.anatomy.severableRegions.includes('legRight')) {
      throw new Error(`archetype ${a.id}: a crawler cannot list legs as severable`);
    }
  }
  return Object.freeze(a);
}

/** A registry of archetypes addressed by a stable numeric index = the SoA `archetype` field. */
export class ArchetypeRegistry {
  private readonly byIndex: ZombieArchetype[] = [];
  private readonly indexById = new Map<string, number>();

  register(a: ZombieArchetype): number {
    if (this.indexById.has(a.id)) throw new Error(`archetype '${a.id}' already registered`);
    const index = this.byIndex.length;
    this.byIndex.push(defineArchetype(a));
    this.indexById.set(a.id, index);
    return index;
  }

  get count(): number {
    return this.byIndex.length;
  }

  byIndexOf(index: number): ZombieArchetype {
    const a = this.byIndex[index];
    if (!a) throw new Error(`no archetype at index ${index}`);
    return a;
  }

  indexOf(id: string): number {
    const i = this.indexById.get(id);
    if (i === undefined) throw new Error(`unknown archetype '${id}'`);
    return i;
  }

  ids(): string[] {
    return [...this.indexById.keys()];
  }

  /**
   * T124/V89 — per-index relative spawn weights (registry order = the SoA `archetype` field). The runtime
   * builds its cumulative weighted-pick table from this so spawn selection is pure config (V4), not a literal.
   */
  spawnWeights(): number[] {
    return this.byIndex.map((a) => a.spawnWeight);
  }

  /**
   * T124/V89 — per-index move-speed multipliers (registry order). The movement step multiplies the shared
   * horde baseline by `[archetype]` so a per-archetype speed actually takes effect in the sim, allocation-free.
   */
  moveSpeedScales(): Float32Array {
    return Float32Array.from(this.byIndex, (a) => a.locomotion.moveSpeedScale);
  }
}
