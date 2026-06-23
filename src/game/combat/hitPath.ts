// T16 / V16 — full combat hit pipeline (extends the GATE-0 firearm subset).
// Pipeline (V16): query chunk-local spatial accel → gather candidates ONLY from the swept cells →
// order by projectile travel → filter by the target's TIER hit geometry (promote to hero when
// detailed anatomy is required, else coarsen the region) → resolve damage vs a NAMED anatomical
// region + armor + penetration + posture → write authoritative SoA (health, anatomyFlags sever bit,
// death) → emit a compact persistent WorldEvent + ephemeral VisualEvent. Player attack damage is
// applied ONLY through a deliberate shot / a timed melee attack-volume window — NEVER from mere
// navigation overlap (V16). Firearm penetration carries the shot through several ordered bodies.

import type { EntityId, EventId, VisualEvent, WorldEvent, AnatomyRegion } from '@/game/core/contracts';
import { CollisionLayer, layerMask, type SpatialHash } from '@/game/navigation/collision';
import { SimTier, type SimulationZombies, type ZombieSlot } from '@/game/simulation';
import type { ResolvedDomain } from '@/config/types';
import type { weaponsConfig } from '@/config/domains/weapons';
import type { combatConfig } from '@/config/domains/combat';
import { damageClass, isFatalRegion, isSeverable, regionBit } from './anatomy';
import { coarsenRegion, needsDetail } from './hitVolume';
import { Posture, limbConsequences } from './segments';

export interface ShotOrigin {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ShotResult {
  readonly hit: boolean;
  readonly targetSlot?: ZombieSlot;
  readonly targetEntity?: EntityId;
  readonly region?: AnatomyRegion;
  readonly effectiveDamage?: number;
  readonly travelMeters?: number;
  readonly killed?: boolean;
  readonly severed?: boolean;
  /** The target was force-promoted to hero for detailed anatomy this hit (V13/V16). */
  readonly promoted?: boolean;
  /** Candidate slots gathered from swept cells before the precise line filter (diagnostics, V16). */
  readonly candidateCount: number;
  /**
   * Distance (m) at which the shot stops: the first body struck, the first projectile-blocking
   * structure cell, or the weapon range — whichever is nearest (V53/B20). Drives the tracer (V49).
   */
  readonly stopDistanceMeters?: number;
}

export interface CombatDeps {
  readonly zombies: SimulationZombies;
  readonly spatial: SpatialHash;
  readonly weapons: ResolvedDomain<typeof weaponsConfig>;
  readonly combat: ResolvedDomain<typeof combatConfig>;
  /** Slot -> stable EntityId for crossing into the event/persistence boundary (V26). */
  readonly entityOf: (slot: ZombieSlot) => EntityId;
  readonly nextEventId: () => EventId;
  readonly worldEvents: { push(e: WorldEvent): boolean };
  readonly visualEvents: { push(e: VisualEvent): boolean };
  /** Lifecycle seam owned by the runtime: record damage time (recent-damage promotion, V13). */
  readonly onDamaged: (slot: ZombieSlot) => void;
  /** Lifecycle seam owned by the runtime: free slot + drop collision agent + unmap on death. */
  readonly onEntityDied: (slot: ZombieSlot) => void;
  /** Optional: promote a struck target to hero fidelity when detailed anatomy is required (V16). */
  readonly promote?: (slot: ZombieSlot) => void;
  /**
   * Structure-occlusion query (V53/B20): distance (m) to the FIRST projectile-blocking structure cell
   * along the ray (an intact, un-breached wall / closed-or-locked door / boarded panel / obstruction),
   * or null when the line of fire is clear to `range`. A breach or open door restores the line locally
   * (V5). Bodies at/beyond this distance take no damage and the shot stops here. Injected by the runtime,
   * which owns the StructuralModule + cell<->world mapping.
   */
  readonly firstProjectileBlockerDistance: (
    origin: ShotOrigin,
    dirX: number,
    dirZ: number,
    range: number,
  ) => number | null;
}

const PROJECTILE_MASK = layerMask(CollisionLayer.Projectile);
const MELEE_MASK = layerMask(CollisionLayer.Movement, CollisionLayer.Attack);

/** A candidate body intersected along a ray, with its travel distance from the muzzle. */
interface RayHit {
  readonly slot: ZombieSlot;
  readonly travel: number;
}

/** Options driving a single damage resolution against one body. */
interface ResolveOpts {
  readonly baseDamage: number;
  readonly armorPenetration: number;
  /** The sim tier whose hit-volume the body is resolved against (per-target). */
  readonly tier: SimTier;
  /** Archetype sever-threshold scale (anatomical damage variation, T21). */
  readonly severScale: number;
  readonly candidateCount: number;
  /** Cumulative damage scale (firearm line-of-fire penetration falloff). */
  readonly damageScale: number;
}

export class CombatSystem {
  constructor(private readonly deps: CombatDeps) {}

  /** Per-region damage multiplier from typed weapon config (V4 — no literals). */
  private regionMultiplier(region: AnatomyRegion): number {
    switch (damageClass(region)) {
      case 'head': return this.deps.weapons.headshotMultiplier;
      case 'torso': return this.deps.weapons.torsoMultiplier;
      case 'limb': return this.deps.weapons.limbMultiplier;
    }
  }

  /** Derive posture from the SoA sever bitfield (V17) — used as the posture term in resolution. */
  private postureOf(slot: ZombieSlot): Posture {
    return limbConsequences(this.deps.zombies.getAnatomyFlags(slot), this.deps.combat).posture;
  }

  /**
   * Sweep ONLY the spatial-hash cells the ray crosses (V16): step along the ray by the broad-phase
   * cell size, gather candidates near each sample, then keep bodies within the line-of-fire radius,
   * ordered by travel. Returns the gather count (diagnostics) + the ordered hit list.
   */
  private gatherAlongRay(
    origin: ShotOrigin,
    ndx: number,
    ndz: number,
    range: number,
    hitRadius: number,
  ): { candidateCount: number; hits: RayHit[]; stopDistance: number } {
    // First projectile-blocking structure along the ray (V53/B20). Bodies at/beyond it are occluded:
    // the shot stops at the wall/closed door/board — no candidates pass through. null = clear to range.
    const blocker = this.deps.firstProjectileBlockerDistance(origin, ndx, ndz, range);
    const blockerDistance = blocker ?? Number.POSITIVE_INFINITY;

    const step = this.deps.spatial.cellSize; // derived from collision config, not a literal
    const gatherRadius = hitRadius + step; // ensure no cell adjacent to the line is missed
    const candidates = new Set<ZombieSlot>();
    for (let t = 0; t <= range + step; t += step) {
      const sx = origin.x + ndx * t;
      const sz = origin.z + ndz * t;
      for (const id of this.deps.spatial.query(sx, sz, gatherRadius, PROJECTILE_MASK)) {
        candidates.add(id);
      }
    }

    const hits: RayHit[] = [];
    const pos: [number, number, number] = [0, 0, 0];
    for (const slot of candidates) {
      if (!this.deps.zombies.isAlive(slot)) continue;
      this.deps.zombies.getPosition(slot, pos);
      const vx = pos[0] - origin.x;
      const vz = pos[2] - origin.z;
      const travel = vx * ndx + vz * ndz;
      if (travel < 0 || travel > range) continue;
      if (travel >= blockerDistance) continue; // occluded: the wall stops the shot before this body
      const perpX = vx - travel * ndx;
      const perpZ = vz - travel * ndz;
      const perp = Math.hypot(perpX, perpZ);
      const agentRadius = this.deps.spatial.get(slot).radius;
      if (perp > hitRadius + agentRadius) continue;
      hits.push({ slot, travel });
    }
    hits.sort((a, b) => a.travel - b.travel);
    // Stop distance = nearest of {first body struck, the blocker, the weapon range} (V49 tracer).
    const firstHitTravel = hits.length > 0 ? hits[0]!.travel : Number.POSITIVE_INFINITY;
    const stopDistance = Math.min(firstHitTravel, blockerDistance, range);
    return { candidateCount: candidates.size, hits, stopDistance };
  }

  /**
   * Fire one firearm ray from `origin` toward (dirX,dirZ), resolving the FIRST body struck at hero
   * fidelity (the documented GATE-0 single-hit subset — kept back-compatible). For ammo, sound and
   * line-of-fire penetration use `firePenetrating` / the WeaponSystem (T18).
   */
  fire(origin: ShotOrigin, dirX: number, dirZ: number, region: AnatomyRegion): ShotResult {
    const { ndx, ndz } = normalizeXZ(dirX, dirZ, 'firearm');
    const range = this.deps.weapons.firearmRangeMeters;
    const hitRadius = this.deps.weapons.firearmHitRadiusMeters;
    const { candidateCount, hits, stopDistance } = this.gatherAlongRay(origin, ndx, ndz, range, hitRadius);
    if (hits.length === 0) return { hit: false, candidateCount, stopDistanceMeters: stopDistance };
    const first = hits[0]!;
    return {
      ...this.resolveHit(first.slot, region, ndx, ndz, first.travel, {
        baseDamage: this.deps.weapons.firearmDamage,
        armorPenetration: this.deps.weapons.firearmArmorPenetration,
        tier: SimTier.Hero,
        severScale: 1,
        candidateCount,
        damageScale: 1,
      }),
      stopDistanceMeters: stopDistance,
    };
  }

  /**
   * Fire one firearm shot that penetrates the line of fire (V16): resolve up to
   * `firearmMaxPenetrations` ordered bodies, each taking damage reduced by the penetration falloff.
   * Each body is resolved against its OWN sim tier's hit volume (promote/coarsen as needed).
   */
  firePenetrating(
    origin: ShotOrigin,
    dirX: number,
    dirZ: number,
    region: AnatomyRegion,
    opts: { tierOverride?: SimTier; severScale?: number } = {},
  ): ShotResult[] {
    const { ndx, ndz } = normalizeXZ(dirX, dirZ, 'firearm');
    const range = this.deps.weapons.firearmRangeMeters;
    const hitRadius = this.deps.weapons.firearmHitRadiusMeters;
    const { candidateCount, hits, stopDistance } = this.gatherAlongRay(origin, ndx, ndz, range, hitRadius);

    const maxBodies = this.deps.weapons.firearmMaxPenetrations;
    const falloff = this.deps.weapons.firearmPenetrationDamageFalloff;
    const results: ShotResult[] = [];
    let damageScale = 1;
    for (const h of hits) {
      if (results.length >= maxBodies) break;
      const tier = opts.tierOverride ?? (this.deps.zombies.getSimTier(h.slot) as SimTier);
      results.push({
        ...this.resolveHit(h.slot, region, ndx, ndz, h.travel, {
          baseDamage: this.deps.weapons.firearmDamage,
          armorPenetration: this.deps.weapons.firearmArmorPenetration,
          tier,
          severScale: opts.severScale ?? 1,
          candidateCount,
          damageScale,
        }),
        stopDistanceMeters: stopDistance,
      });
      damageScale *= falloff;
    }
    return results;
  }

  /**
   * Resolve a melee SWEEP attack volume (V16/T18): every alive body inside the arc (half-angle of
   * `meleeArcDegrees`) and within `meleeRangeMeters` of `origin` is struck. Damage is applied ONLY
   * by this call — the caller (WeaponSystem) gates it to the active animation window so navigation
   * overlap can never deal damage (V16).
   */
  meleeSweep(
    origin: ShotOrigin,
    dirX: number,
    dirZ: number,
    region: AnatomyRegion,
    opts: { tierOverride?: SimTier; severScale?: number } = {},
  ): ShotResult[] {
    const { ndx, ndz } = normalizeXZ(dirX, dirZ, 'melee');
    const range = this.deps.weapons.meleeRangeMeters;
    const halfCos = Math.cos((this.deps.weapons.meleeArcDegrees * Math.PI) / 180 / 2);

    const candidates = this.deps.spatial.query(origin.x, origin.z, range, MELEE_MASK);
    const candidateCount = candidates.length;
    const pos: [number, number, number] = [0, 0, 0];
    const results: ShotResult[] = [];
    for (const slot of candidates) {
      if (!this.deps.zombies.isAlive(slot)) continue;
      this.deps.zombies.getPosition(slot, pos);
      const tx = pos[0] - origin.x;
      const tz = pos[2] - origin.z;
      const dist = Math.hypot(tx, tz);
      const agentRadius = this.deps.spatial.get(slot).radius;
      if (dist > range + agentRadius) continue;
      // arc test (a body at the origin is always in arc)
      if (dist > 0) {
        const cos = (tx / dist) * ndx + (tz / dist) * ndz;
        if (cos < halfCos) continue;
      }
      const tier = opts.tierOverride ?? (this.deps.zombies.getSimTier(slot) as SimTier);
      results.push(
        this.resolveHit(slot, region, ndx, ndz, dist, {
          baseDamage: this.deps.weapons.meleeDamage,
          armorPenetration: this.deps.weapons.meleeArmorPenetration,
          tier,
          severScale: opts.severScale ?? 1,
          candidateCount,
          damageScale: 1,
        }),
      );
    }
    return results;
  }

  /** Resolve damage authoritatively against the SoA + emit the compact events (V16). */
  private resolveHit(
    slot: ZombieSlot,
    aimRegion: AnatomyRegion,
    ndx: number,
    ndz: number,
    travel: number,
    opts: ResolveOpts,
  ): ShotResult {
    const z = this.deps.zombies;
    const entity = this.deps.entityOf(slot);

    // --- tier hit-volume filter + promotion (V16) ---
    let region = aimRegion;
    let promoted = false;
    if (needsDetail(opts.tier, aimRegion)) {
      if (this.deps.combat.promoteOnDetailedHit && this.deps.promote) {
        this.deps.promote(slot); // promote to hero; keep the aimed (detailed) region
        promoted = true;
      } else {
        region = coarsenRegion(opts.tier, aimRegion);
      }
    }

    // --- damage = base * region mult * penetration scale, posture term, minus armor net of penetration ---
    const posture = this.postureOf(slot);
    const postureMult = posture === Posture.Standing ? 1 : this.deps.combat.postureDownDamageMultiplier;
    const raw = opts.baseDamage * this.regionMultiplier(region) * opts.damageScale * postureMult;
    const armorLeft = this.deps.combat.zombieBaseArmor * (1 - opts.armorPenetration);
    const effective = Math.max(0, raw - armorLeft);

    // --- sever a severable region whose effective damage crosses the (archetype-scaled) threshold (V17) ---
    let severed = false;
    const severThreshold = this.deps.combat.severDamageThreshold * opts.severScale;
    if (isSeverable(region) && effective >= severThreshold) {
      z.setAnatomyFlags(slot, z.getAnatomyFlags(slot) | regionBit(region));
      severed = true;
    }

    // --- apply health: head/neck fatal when enabled, regardless of remaining health (V17 head-kill) ---
    const fatalHead = isFatalRegion(region) && this.deps.combat.headFatalEnabled;
    const newHealth = fatalHead ? 0 : Math.max(0, z.getHealth(slot) - effective);
    z.setHealth(slot, newHealth);
    const killed = newHealth <= 0;

    this.deps.onDamaged(slot);

    // persistent world facts (feed save/AI). EntityId crosses the boundary, never the raw slot (V26).
    this.deps.worldEvents.push({
      kind: 'hitResolved',
      id: this.deps.nextEventId(),
      target: entity,
      region,
      damage: effective,
      severed,
    });

    // ephemeral render facts (reaction + spray + detach), never persisted (§I).
    const pos: [number, number, number] = [0, 0, 0];
    z.getPosition(slot, pos);
    this.deps.visualEvents.push({
      kind: 'hitReaction',
      id: this.deps.nextEventId(),
      target: entity,
      region,
      dirX: ndx,
      dirZ: ndz,
      energy: effective,
    });
    this.deps.visualEvents.push({
      kind: 'bloodSpray',
      id: this.deps.nextEventId(),
      x: pos[0],
      y: pos[1],
      z: pos[2],
      dirX: ndx,
      dirZ: ndz,
    });
    if (severed) {
      this.deps.visualEvents.push({
        kind: 'partDetached',
        id: this.deps.nextEventId(),
        target: entity,
        region,
      });
    }

    if (killed) {
      this.deps.worldEvents.push({ kind: 'entityDied', id: this.deps.nextEventId(), entity });
      this.deps.onEntityDied(slot); // runtime frees slot + drops collision agent + unmaps
    }

    return {
      hit: true,
      targetSlot: slot,
      targetEntity: entity,
      region,
      effectiveDamage: effective,
      travelMeters: travel,
      killed,
      severed,
      promoted,
      candidateCount: opts.candidateCount,
    };
  }
}

function normalizeXZ(dirX: number, dirZ: number, what: string): { ndx: number; ndz: number } {
  const len = Math.hypot(dirX, dirZ);
  if (len === 0) throw new Error(`${what} direction must be non-zero in the xz plane`);
  return { ndx: dirX / len, ndz: dirZ / len };
}
