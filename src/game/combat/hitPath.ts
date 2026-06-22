// T41 / V16 — firearm hit pipeline (forward-pulled subset of T16/T18).
// Pipeline (V16): cast a ray from the muzzle → gather candidates ONLY from the collision spatial-hash
// cells the ray sweeps (never the whole grid) → order by projectile travel → pick the first body →
// resolve damage vs a NAMED anatomical region + armor + penetration → write authoritative SoA
// (health, anatomyFlags sever bit, death) → emit a persistent WorldEvent (hitResolved/entityDied)
// + an ephemeral VisualEvent (hitReaction/bloodSpray). Player damage is applied ONLY here, from a
// deliberate shot — never from navigation overlap (V16).

import type { EntityId, EventId, VisualEvent, WorldEvent, AnatomyRegion } from '@/game/core/contracts';
import { CollisionLayer, layerMask, type SpatialHash } from '@/game/navigation/collision';
import type { SimulationZombies, ZombieSlot } from '@/game/simulation';
import type { ResolvedDomain } from '@/config/types';
import type { weaponsConfig } from '@/config/domains/weapons';
import type { combatConfig } from '@/config/domains/combat';
import { damageClass, isFatalRegion, isSeverable, regionBit } from './anatomy';

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
  /** Candidate slots gathered from swept cells before the precise line filter (diagnostics, V16). */
  readonly candidateCount: number;
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
}

const PROJECTILE_MASK = layerMask(CollisionLayer.Projectile);

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

  /**
   * Fire one firearm ray from `origin` along horizontal direction (dirX,dirZ), targeting `region`.
   * Returns the resolved hit. The region is supplied by the aiming layer; full hit-volume/tier-based
   * region selection is T18 — here it is an explicit input (the documented GATE-0 subset).
   */
  fire(origin: ShotOrigin, dirX: number, dirZ: number, region: AnatomyRegion): ShotResult {
    const len = Math.hypot(dirX, dirZ);
    if (len === 0) throw new Error('firearm direction must be non-zero in the xz plane');
    const ndx = dirX / len;
    const ndz = dirZ / len;
    const range = this.deps.weapons.firearmRangeMeters;
    const hitRadius = this.deps.weapons.firearmHitRadiusMeters;

    // --- gather: sweep only the spatial-hash cells the ray crosses (V16) ---
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

    // --- order by travel + filter by precise line-of-fire distance ---
    let bestSlot = -1;
    let bestTravel = Number.POSITIVE_INFINITY;
    const pos: [number, number, number] = [0, 0, 0];
    for (const slot of candidates) {
      if (!this.deps.zombies.isAlive(slot)) continue;
      this.deps.zombies.getPosition(slot, pos);
      const vx = pos[0] - origin.x;
      const vz = pos[2] - origin.z;
      const travel = vx * ndx + vz * ndz;
      if (travel < 0 || travel > range) continue;
      const perpX = vx - travel * ndx;
      const perpZ = vz - travel * ndz;
      const perp = Math.hypot(perpX, perpZ);
      const agentRadius = this.deps.spatial.get(slot).radius;
      if (perp > hitRadius + agentRadius) continue;
      if (travel < bestTravel) {
        bestTravel = travel;
        bestSlot = slot;
      }
    }

    if (bestSlot < 0) return { hit: false, candidateCount: candidates.size };

    return this.resolve(bestSlot, region, ndx, ndz, bestTravel, candidates.size);
  }

  /** Resolve damage authoritatively against the SoA + emit the compact events (V16). */
  private resolve(
    slot: ZombieSlot,
    region: AnatomyRegion,
    ndx: number,
    ndz: number,
    travel: number,
    candidateCount: number,
  ): ShotResult {
    const z = this.deps.zombies;
    const entity = this.deps.entityOf(slot);

    // damage = base * region multiplier, reduced by armor net of penetration (V16).
    const raw = this.deps.weapons.firearmDamage * this.regionMultiplier(region);
    const armorLeft = this.deps.combat.zombieBaseArmor * (1 - this.deps.weapons.firearmArmorPenetration);
    const effective = Math.max(0, raw - armorLeft);

    // sever a severable region whose effective damage crosses the threshold (V17).
    let severed = false;
    if (isSeverable(region) && effective >= this.deps.combat.severDamageThreshold) {
      z.setAnatomyFlags(slot, z.getAnatomyFlags(slot) | regionBit(region));
      severed = true;
    }

    // apply health: head/neck is fatal when enabled, regardless of remaining health (V17 head-kill).
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

    // ephemeral render facts (reaction + spray), never persisted (§I).
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
      candidateCount,
    };
  }
}
