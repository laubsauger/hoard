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
import { SimTier, ZombieState, type SimulationZombies, type ZombieSlot } from '@/game/simulation';
import type { ResolvedDomain } from '@/config/types';
import type { weaponsConfig } from '@/config/domains/weapons';
import type { combatConfig } from '@/config/domains/combat';
import { damageClass, isFatalRegion, isSeverable, regionBit } from './anatomy';
import { coarsenRegion, needsDetail } from './hitVolume';
import { Posture, limbConsequences } from './segments';
import { buildWeaponRegistry, WEAPON_IDS, type WeaponClass, type WeaponId } from './weaponRegistry';

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
  /** The hit was non-lethal but knocked the body into a brief stagger (slowed/interrupted) (V16/V17). */
  readonly staggered?: boolean;
  /** The target was force-promoted to hero for detailed anatomy this hit (V13/V16). */
  readonly promoted?: boolean;
  /** Candidate slots gathered from swept cells before the precise line filter (diagnostics, V16). */
  readonly candidateCount: number;
  /**
   * Distance (m) at which the shot stops: the first body struck, the first projectile-blocking
   * structure cell, or the weapon range — whichever is nearest (V53/B20). Drives the tracer (V49).
   */
  readonly stopDistanceMeters?: number;
  /**
   * Rounds the equipped weapon spent on this call (T74): 1 for a resolved shot (a shotgun spends ONE
   * shell for its whole pellet pattern), 0 for a no-fire (empty magazine, mid-reload or mid-swap). A
   * dry click does not resolve damage — `hit` is false and `firedRounds` is 0.
   */
  readonly firedRounds?: number;
  /** True when the call was a dry click on an empty magazine (no round chambered, no damage) (T74). */
  readonly empty?: boolean;
}

/**
 * T131/V99 — the KINETIC IMPACT of the killing blow, surfaced to the death seam so the corpse topples in the
 * shot's push direction. `dirX`/`dirZ` is the normalized attack (bullet / swing) travel direction — the body
 * falls ALONG it (front shot → onto its back); `force` is the effective damage of the lethal hit (drives how
 * hard / fast it tumbles). A non-combat death (lifetime expiry) carries no impact → a default heading collapse.
 */
export interface DeathImpact {
  readonly dirX: number;
  readonly dirZ: number;
  readonly force: number;
}

/** Live ammunition state of the equipped weapon for a HUD/UI (T74). Melee reports unlimited (Infinity). */
export interface AmmoStatus {
  /** Rounds chambered in the magazine (Infinity for the unlimited melee class). */
  readonly magazine: number;
  /** Spare rounds in reserve, fed into the magazine on reload (Infinity for melee). */
  readonly reserve: number;
  /** True while a reload of the equipped weapon is in progress (fire is blocked). */
  readonly reloading: boolean;
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
  /** Lifecycle seam owned by the runtime: free slot + drop collision agent + unmap on death. The killing hit's
   *  kinetic IMPACT (T131/V99) rides along so the corpse topples in the shot's push direction; absent for a
   *  non-combat death (lifetime expiry → a default heading collapse, force 0). */
  readonly onEntityDied: (slot: ZombieSlot, impact?: DeathImpact) => void;
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
  /**
   * Optional authoritative tick source for the deterministic reload/swap timers (T74). When supplied
   * (e.g. the runtime wiring `() => clock.tick`) every reload/swap deadline is measured against it. When
   * omitted, the system tracks its own monotonic tick advanced explicitly by `CombatSystem.tick(dtTicks)`
   * — both paths are deterministic; pick exactly ONE per CombatSystem instance.
   */
  readonly nowTick?: () => number;
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
  /** Immutable per-weapon ballistic models, assembled from typed config (T73/V50). */
  private readonly weaponRegistry: Readonly<Record<WeaponId, WeaponClass>>;
  /** The equipped weapon class `fire` resolves against. Defaults to the pistol (GATE-0 parity). */
  private equippedId: WeaponId = 'pistol';

  // ---- T74 ammo + deterministic reload/swap timers ----
  /** Per-firearm magazine + reserve. Melee is unlimited and carries no entry here. */
  private readonly ammo: Partial<Record<WeaponId, { magazine: number; reserve: number }>> = {};
  /** Self-tracked monotonic tick, used only when no `deps.nowTick` source is supplied. */
  private internalTick = 0;
  /** Monotonic per-resolved-hit nonce — seeds the deterministic hit-location roll (V26 replay-stable). */
  private hitSeq = 0;
  /** A reload or swap is in flight until `busyUntilTick`; null when the weapon is ready. */
  private busyKind: 'reload' | 'swap' | null = null;
  /** Tick at which the in-flight reload/swap completes (deadline measured against `now()`). */
  private busyUntilTick = 0;
  /** The weapon a pending reload refills (its rounds move reserve->magazine when the reload settles). */
  private reloadingWeapon: WeaponId | null = null;

  constructor(private readonly deps: CombatDeps) {
    this.weaponRegistry = buildWeaponRegistry(deps.weapons);
    // Each firearm class starts with a FULL magazine (GATE-0 parity: the default weapon fires at once)
    // plus its configured reserve. Melee carries no ammo entry — it is unlimited (T74).
    for (const id of WEAPON_IDS) {
      const w = this.weaponRegistry[id];
      if (w.magazineSize !== undefined && w.reserveAmmo !== undefined) {
        this.ammo[id] = { magazine: w.magazineSize, reserve: w.reserveAmmo };
      }
    }
  }

  /** The current authoritative tick: the injected source if present, else the self-tracked counter (T74). */
  private now(): number {
    return this.deps.nowTick ? this.deps.nowTick() : this.internalTick;
  }

  /**
   * Settle any in-flight reload/swap whose deadline the clock has reached (T74). A completed reload moves
   * rounds reserve->magazine for its weapon; a completed swap simply clears the ready delay. Called at the
   * head of every state-reading entry point so timers resolve lazily and deterministically.
   */
  private settle(): void {
    if (this.busyKind === null || this.now() < this.busyUntilTick) return;
    if (this.busyKind === 'reload' && this.reloadingWeapon !== null) {
      const w = this.weaponRegistry[this.reloadingWeapon];
      const state = this.ammo[this.reloadingWeapon];
      if (state && w.magazineSize !== undefined) {
        const moved = Math.min(w.magazineSize - state.magazine, state.reserve);
        state.magazine += moved;
        state.reserve -= moved;
      }
    }
    this.busyKind = null;
    this.reloadingWeapon = null;
  }

  /**
   * Advance the self-tracked tick by `dtTicks` and settle due reload/swap timers (T74). Use this ONLY
   * when no `deps.nowTick` source is injected; it keeps reload/swap deterministic under a fixed clock.
   */
  tick(dtTicks = 1): void {
    if (!Number.isInteger(dtTicks) || dtTicks < 0) {
      throw new Error(`tick(dtTicks) expects a non-negative integer, got ${dtTicks}`);
    }
    if (this.deps.nowTick) {
      throw new Error('CombatSystem.tick is unavailable when an external nowTick source is injected');
    }
    this.internalTick += dtTicks;
    this.settle();
  }

  /** Equip a weapon class immediately (no swap delay) — the inventory/loadout primitive (T73/V50). */
  setWeapon(id: WeaponId): void {
    if (!(id in this.weaponRegistry)) {
      throw new Error(`unknown weapon class '${id}'`);
    }
    this.equippedId = id;
  }

  /**
   * Cycle the equipped weapon by `dir` (+1 / -1) around the registry order and arm the new class's swap
   * ready delay — `fire` is blocked until the swap settles (T74). A cycle requested while a reload or an
   * earlier swap is still in flight is ignored (the equipped weapon is unchanged) so timers never stack.
   * Returns the now-equipped weapon id.
   */
  cycleWeapon(dir: 1 | -1): WeaponId {
    this.settle();
    if (dir !== 1 && dir !== -1) {
      throw new Error(`cycleWeapon expects +1 or -1, got ${dir}`);
    }
    if (this.busyKind !== null) return this.equippedId;
    const n = WEAPON_IDS.length;
    const idx = WEAPON_IDS.indexOf(this.equippedId);
    const next = WEAPON_IDS[(idx + dir + n) % n]!;
    this.equippedId = next;
    const swapTicks = this.weaponRegistry[next].swapTicks;
    if (swapTicks > 0) {
      this.busyKind = 'swap';
      this.busyUntilTick = this.now() + swapTicks;
    }
    return next;
  }

  /**
   * Reload the equipped firearm: begin moving rounds reserve->magazine over its `reloadTicks` (T74).
   * `fire` is blocked until the reload settles. Returns false (no reload started) when the class is
   * unlimited melee, the system is already busy, the magazine is already full, or the reserve is empty
   * (out of reserve cannot reload — no silent top-up).
   */
  reload(): boolean {
    this.settle();
    const w = this.weaponRegistry[this.equippedId];
    if (w.reloadTicks === undefined) return false; // melee: unlimited, nothing to reload
    if (this.busyKind !== null) return false; // a reload/swap is already in flight
    const state = this.ammo[this.equippedId];
    if (!state || w.magazineSize === undefined) return false;
    if (state.reserve <= 0) return false; // out of reserve
    if (state.magazine >= w.magazineSize) return false; // already full
    this.busyKind = 'reload';
    this.reloadingWeapon = this.equippedId;
    this.busyUntilTick = this.now() + w.reloadTicks;
    return true;
  }

  /** True while a reload of the equipped weapon is in flight (fire is blocked) (T74). */
  isReloading(): boolean {
    this.settle();
    return this.busyKind === 'reload';
  }

  /** Live ammo state of the equipped weapon for a HUD/UI; melee reports unlimited (Infinity) (T74). */
  currentAmmo(): AmmoStatus {
    this.settle();
    const state = this.ammo[this.equippedId];
    if (!state) {
      return { magazine: Number.POSITIVE_INFINITY, reserve: Number.POSITIVE_INFINITY, reloading: false };
    }
    return { magazine: state.magazine, reserve: state.reserve, reloading: this.busyKind === 'reload' };
  }

  /** The equipped weapon's stable id, for a HUD/UI (T74). */
  currentWeaponId(): WeaponId {
    return this.equippedId;
  }

  /** The currently-equipped weapon class model (T73/V50). */
  currentWeapon(): WeaponClass {
    return this.weaponRegistry[this.equippedId];
  }

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

    // Bug B: a standing-aim shot holds a flat projectile height; a body whose vertical extent (top) sits
    // below it is passed OVER — the round flies above a corpse / prone / crawling body on the floor.
    const aimHeight = this.deps.combat.shotProjectileHeightMeters;

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
      // Bug B height gate: a floored body (prone/crawling/downed) only reaches `flooredBodyHeightMeters`,
      // an upright body reaches `standingBodyHeightMeters`. When the flat shot rides above the body's top,
      // the round passes over it (no candidate) — a melee sweep, which ignores this gate, can still hit it.
      const bodyTop = this.postureOf(slot) === Posture.Standing
        ? this.deps.combat.standingBodyHeightMeters
        : this.deps.combat.flooredBodyHeightMeters;
      if (aimHeight > bodyTop) continue;
      hits.push({ slot, travel });
    }
    hits.sort((a, b) => a.travel - b.travel);
    // Stop distance = nearest of {first body struck, the blocker, the weapon range} (V49 tracer).
    const firstHitTravel = hits.length > 0 ? hits[0]!.travel : Number.POSITIVE_INFINITY;
    const stopDistance = Math.min(firstHitTravel, blockerDistance, range);
    return { candidateCount: candidates.size, hits, stopDistance };
  }

  /**
   * Fire the EQUIPPED weapon class from `origin` toward (dirX,dirZ), resolving its full ballistic model
   * (T73/V50): one ray per pellet across the weapon's angular spread; along each ray a penetration
   * BUDGET (stopping power) is consumed per body by its resistance, so the shot pierces bodies until the
   * budget is exhausted — a pistol stops at 1 body, a rifle pierces several, a shotgun fires many pellets
   * in a spread. Damage falls off with travel distance. Returns the PRIMARY resolved hit (first body of
   * the centre ray) as a single ShotResult, always carrying the true `stopDistanceMeters` of that ray
   * (V49/V53). Every other penetrated body / pellet is resolved as a side effect (authoritative SoA +
   * events). For ammo, sound and the timed melee window use the WeaponSystem (T18).
   */
  /**
   * Deterministically roll the struck body region from the config hit-location weights (V26 — seeded by the
   * authoritative tick + a per-hit nonce, so a replay re-rolls identically). Models accuracy scatter around
   * center-mass so limbs + head get hit (→ dismemberment), without the player aiming a specific limb.
   */
  /** Next deterministic pseudo-random in [0,1) seeded by (authoritative tick, per-hit nonce) — replay-stable
   *  (V26). Drives the per-shot aim jitter; the hit-location roll has its own draw. */
  private nextRand01(): number {
    const t = this.now() | 0;
    const n = this.hitSeq++;
    const h = (Math.imul(t ^ 0x85ebca6b, 2654435761) ^ Math.imul(n + 1, 374761393)) >>> 0;
    return (h >>> 8) / 0x0100_0000;
  }

  private rollHitRegion(): AnatomyRegion {
    const c = this.deps.combat;
    const t = this.now() | 0;
    const n = this.hitSeq++;
    // Cheap integer hash of (tick, nonce) → two decorrelated streams: `r` picks the band, low bits pick L/R.
    const h = (Math.imul(t ^ 0x9e3779b1, 2654435761) ^ Math.imul(n + 1, 40503)) >>> 0;
    const r = (h >>> 8) / 0x0100_0000; // [0,1)
    const total = c.hitWeightHead + c.hitWeightTorso + c.hitWeightArm + c.hitWeightLeg;
    let x = r * (total > 0 ? total : 1);
    if ((x -= c.hitWeightHead) < 0) return 'head';
    if ((x -= c.hitWeightTorso) < 0) return 'torsoUpper';
    if ((x -= c.hitWeightArm) < 0) return (h & 1) === 0 ? 'armLeft' : 'armRight';
    return (h & 2) === 0 ? 'legLeft' : 'legRight';
  }

  fire(origin: ShotOrigin, dirX: number, dirZ: number, region: AnatomyRegion, opts: { rollHitLocation?: boolean } = {}): ShotResult {
    this.settle();
    const weapon = this.weaponRegistry[this.equippedId];

    // T74: fire is blocked while a reload or swap is in flight — a no-fire that resolves no damage.
    if (this.busyKind !== null) {
      return { hit: false, candidateCount: 0, stopDistanceMeters: weapon.rangeMeters, firedRounds: 0 };
    }

    // T74 ammo: a firearm spends ONE round per shot (a shotgun spends one SHELL for its pellet pattern).
    // An empty magazine is a dry click — no damage. Melee carries no ammo entry and is unlimited.
    const state = this.ammo[this.equippedId];
    if (state) {
      if (state.magazine <= 0) {
        if (this.deps.weapons.autoReloadWhenEmpty && state.reserve > 0) this.reload();
        return {
          hit: false,
          candidateCount: 0,
          stopDistanceMeters: weapon.rangeMeters,
          firedRounds: 0,
          empty: true,
        };
      }
      state.magazine -= 1;
    }

    const { ndx: rawX, ndz: rawZ } = normalizeXZ(dirX, dirZ, 'firearm');
    const range = weapon.rangeMeters;
    const hitRadius = this.deps.weapons.firearmHitRadiusMeters;
    const resistance = this.deps.combat.bodyPenetrationResistance;
    const spreadRad = (weapon.spreadDegrees * Math.PI) / 180;
    // Per-SHOT accuracy jitter: rotate the whole aim by a small random yaw so no shot is pixel-perfect (the
    // pellet pattern fans around this jittered centre). Scatters the impact in the ground plane (both axes);
    // body-height variety comes from the hit-location roll. Deterministic (V26). Zero spread → no jitter.
    const accRad = (this.deps.weapons.firearmAccuracySpreadDegrees * Math.PI) / 180;
    const yaw = accRad > 0 ? (this.nextRand01() - 0.5) * accRad : 0;
    const jc = Math.cos(yaw);
    const js = Math.sin(yaw);
    const ndx = rawX * jc - rawZ * js;
    const ndz = rawX * js + rawZ * jc;

    let primary: ShotResult | undefined;
    let centreStop = range;
    let centreCandidates = 0;

    for (let i = 0; i < weapon.pellets; i++) {
      // Deterministic, symmetric spread: pellet i is fanned from -spread/2 .. +spread/2 (centre = 0).
      const angle = weapon.pellets === 1 ? 0 : -spreadRad / 2 + (spreadRad * i) / (weapon.pellets - 1);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const px = ndx * cos - ndz * sin;
      const pz = ndx * sin + ndz * cos;

      const { candidateCount, hits, stopDistance } = this.gatherAlongRay(origin, px, pz, range, hitRadius);
      if (i === 0) {
        centreStop = stopDistance;
        centreCandidates = candidateCount;
      }

      // Walk the ordered bodies, spending the penetration budget per body until it is exhausted (V50).
      let budget = weapon.stoppingPower;
      for (const h of hits) {
        if (budget <= 0) break;
        const falloff = Math.max(0, 1 - h.travel * weapon.damageFalloffPerMeter);
        // Scatter the struck region per body when the caller opted in (player/sim fire); a precise/targeted
        // shot (tests, fireAtEntity) keeps the requested region. Rolling per body gives dismemberment variety.
        const hitRegion = opts.rollHitLocation ? this.rollHitRegion() : region;
        const shot = this.resolveHit(h.slot, hitRegion, px, pz, h.travel, {
          baseDamage: weapon.damage,
          armorPenetration: weapon.armorPenetration,
          tier: SimTier.Hero,
          severScale: 1,
          candidateCount,
          damageScale: falloff,
        });
        if (!primary) {
          primary = { ...shot, stopDistanceMeters: stopDistance };
        }
        budget -= resistance;
      }
    }

    // The round was already spent (or the class is unlimited melee): this call fired exactly once.
    if (primary) return { ...primary, firedRounds: 1 };
    return { hit: false, candidateCount: centreCandidates, stopDistanceMeters: centreStop, firedRounds: 1 };
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

    // --- T57 wound reaction (V16/V17): a surviving NON-head hit that lands hard enough knocks the body
    // into a brief stagger (slowed/interrupted). Head/neck stays the lethal class; accumulating chip
    // damage from ordinary hits eventually kills. Stagger is driven through the SoA state + stateTimer
    // (seconds) so behaviour can slow/interrupt the staggered body. Lethal hits skip it (it's dead). ---
    let staggered = false;
    if (!killed && !isFatalRegion(region) && effective >= this.deps.combat.staggerDamageThreshold) {
      z.setState(slot, ZombieState.Stagger);
      z.setStateTimer(slot, this.deps.combat.staggerDurationSeconds);
      staggered = true;
    }

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
      // T131/V99: carry the killing hit's kinetic vector (bullet/swing direction + effective damage) so the
      // corpse topples in the push direction — front shot onto its back, behind onto its face, side sideways.
      this.deps.onEntityDied(slot, { dirX: ndx, dirZ: ndz, force: effective });
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
      staggered,
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
