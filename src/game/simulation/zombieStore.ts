// T8 / V3 / V26 — data-oriented SoA zombie store.
// Authoritative high-count zombie data lives in ONE backing buffer (frozen ZOMBIE_FIELDS layout),
// addressed by a stable slot index. Identity = slot; the slot never moves while a zombie is alive,
// so tier promotion/demotion (T10) and field mutation never disturb unrelated fields (V13).
// Ownership-named accessor view is `SimulationZombie` — NOT an overloaded `Zombie` object (§I/V26).

import { allocateSoa, ZOMBIE_FIELDS } from '@/game/core/contracts';
import { resolveDomain } from '@/config/registry';
import { zombiesConfig } from '@/config/domains/zombies';
import type { QualityTier } from '@/config/types';

/** Stable index into the SoA store. Treat as opaque identity, not as an array position to reorder. */
export type ZombieSlot = number;

/** Behaviour FSM state ids (small enum stored in the u8 `state` field). */
export enum ZombieState {
  Idle = 0,
  Wander = 1,
  Pursue = 2,
  Attack = 3,
  Stagger = 4,
  Down = 5,
}

/** Initial values for a spawned zombie. Position + archetype are required; the rest default. */
export interface ZombieSpawn {
  readonly archetype: number;
  readonly position: readonly [number, number, number];
  readonly heading?: number;
  readonly velocity?: readonly [number, number, number];
  readonly state?: number;
  readonly health: number;
  readonly anatomyFlags?: number;
  readonly target?: number;
  readonly stimulus?: number;
  readonly chunk?: number;
  readonly spatialCell?: number;
  readonly navGroup?: number;
  readonly simTier?: number;
  readonly renderTier?: number;
  readonly animState?: number;
  readonly animPhase?: number;
}

const REFERENCE_TIER: QualityTier = 'desktop-high';

/** Resolve the zombies config capacity for a tier (V4 — capacity is config, not a literal). */
export function resolveCapacity(tier: QualityTier = REFERENCE_TIER): number {
  return resolveDomain(zombiesConfig, tier).capacity;
}

export class SimulationZombies {
  private readonly _capacity: number;
  private readonly soa: ReturnType<typeof allocateSoa>;

  // Typed views onto the single backing buffer (one allocation, shareable across workers).
  private readonly fArchetype: Uint16Array;
  private readonly fAlive: Uint8Array;
  private readonly fPosition: Float32Array;
  private readonly fHeading: Float32Array;
  private readonly fVelocity: Float32Array;
  private readonly fState: Uint8Array;
  private readonly fStateTimer: Float32Array;
  private readonly fHealth: Float32Array;
  private readonly fAnatomyFlags: Uint32Array;
  private readonly fTarget: Int32Array;
  private readonly fStimulus: Int32Array;
  private readonly fChunk: Int32Array;
  private readonly fSpatialCell: Int32Array;
  private readonly fNavGroup: Int32Array;
  private readonly fSimTier: Uint8Array;
  private readonly fRenderTier: Uint8Array;
  private readonly fAnimState: Uint8Array;
  private readonly fAnimPhase: Float32Array;

  /** Free-list stack of reusable slots. Initialised so the first spawns yield 0,1,2,… */
  private readonly freeStack: number[] = [];
  private _count = 0;

  constructor(capacity: number = resolveCapacity()) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`SimulationZombies capacity must be a positive integer, got ${capacity}`);
    }
    this._capacity = capacity;
    this.soa = allocateSoa(ZOMBIE_FIELDS, capacity);
    const v = this.soa.views;
    this.fArchetype = v.archetype as Uint16Array;
    this.fAlive = v.alive as Uint8Array;
    this.fPosition = v.position as Float32Array;
    this.fHeading = v.heading as Float32Array;
    this.fVelocity = v.velocity as Float32Array;
    this.fState = v.state as Uint8Array;
    this.fStateTimer = v.stateTimer as Float32Array;
    this.fHealth = v.health as Float32Array;
    this.fAnatomyFlags = v.anatomyFlags as Uint32Array;
    this.fTarget = v.target as Int32Array;
    this.fStimulus = v.stimulus as Int32Array;
    this.fChunk = v.chunk as Int32Array;
    this.fSpatialCell = v.spatialCell as Int32Array;
    this.fNavGroup = v.navGroup as Int32Array;
    this.fSimTier = v.simTier as Uint8Array;
    this.fRenderTier = v.renderTier as Uint8Array;
    this.fAnimState = v.animState as Uint8Array;
    this.fAnimPhase = v.animPhase as Float32Array;
    for (let i = capacity - 1; i >= 0; i--) this.freeStack.push(i);
  }

  get capacity(): number {
    return this._capacity;
  }

  /** Number of currently alive zombies. */
  get count(): number {
    return this._count;
  }

  /** Free slots available for spawning. */
  get freeCount(): number {
    return this.freeStack.length;
  }

  /** Raw field views — for systems that batch-process the SoA (render lane reads, never owns). */
  get views() {
    return this.soa.views;
  }

  /** The shared backing buffer (transferable / SharedArrayBuffer-backed when allocated shared). */
  get buffer() {
    return this.soa.buffer;
  }

  isAlive(slot: ZombieSlot): boolean {
    this.assertSlot(slot);
    return this.fAlive[slot] === 1;
  }

  /** Reserve a slot (free-list reuse) and initialise it. Throws when capacity is exhausted (no silent drop). */
  spawn(init: ZombieSpawn): ZombieSlot {
    const slot = this.freeStack.pop();
    if (slot === undefined) {
      throw new Error(`SimulationZombies capacity ${this._capacity} exhausted (no free slot)`);
    }
    this.resetSlot(slot);
    this.fAlive[slot] = 1;
    this.fArchetype[slot] = init.archetype;
    this.setPosition(slot, init.position[0], init.position[1], init.position[2]);
    this.fHeading[slot] = init.heading ?? 0;
    if (init.velocity) this.setVelocity(slot, init.velocity[0], init.velocity[1], init.velocity[2]);
    this.fState[slot] = init.state ?? ZombieState.Idle;
    this.fHealth[slot] = init.health;
    this.fAnatomyFlags[slot] = init.anatomyFlags ?? 0;
    this.fTarget[slot] = init.target ?? -1;
    this.fStimulus[slot] = init.stimulus ?? -1;
    this.fChunk[slot] = init.chunk ?? -1;
    this.fSpatialCell[slot] = init.spatialCell ?? -1;
    this.fNavGroup[slot] = init.navGroup ?? -1;
    this.fSimTier[slot] = init.simTier ?? 3; // default abstract until tiered
    this.fRenderTier[slot] = init.renderTier ?? 3;
    this.fAnimState[slot] = init.animState ?? 0;
    this.fAnimPhase[slot] = init.animPhase ?? 0;
    this._count += 1;
    return slot;
  }

  /** Release a slot back to the free list. The slot becomes reusable by a later spawn. */
  free(slot: ZombieSlot): void {
    this.assertSlot(slot);
    if (this.fAlive[slot] !== 1) throw new Error(`cannot free slot ${slot}: not alive`);
    this.fAlive[slot] = 0;
    this.freeStack.push(slot);
    this._count -= 1;
  }

  /** Iterate every alive slot in ascending order. */
  forEachAlive(fn: (slot: ZombieSlot) => void): void {
    for (let slot = 0; slot < this._capacity; slot++) {
      if (this.fAlive[slot] === 1) fn(slot);
    }
  }

  /** Count alive zombies whose XZ position is within `radius` m of (x,z). Cheap O(capacity) scan, no alloc —
   *  drives PROXIMITY-scaled horde audio (the bed must answer "how many are near ME", not the global count). */
  nearbyCount(x: number, z: number, radius: number): number {
    const r2 = radius * radius;
    let n = 0;
    for (let slot = 0; slot < this._capacity; slot++) {
      if (this.fAlive[slot] !== 1) continue;
      const b = slot * 3;
      const dx = this.fPosition[b]! - x;
      const dz = this.fPosition[b + 2]! - z;
      if (dx * dx + dz * dz <= r2) n += 1;
    }
    return n;
  }

  /** Lazy generator over alive slots. */
  *aliveSlots(): IterableIterator<ZombieSlot> {
    for (let slot = 0; slot < this._capacity; slot++) {
      if (this.fAlive[slot] === 1) yield slot;
    }
  }

  /** Ergonomic per-entity accessor view (created on demand; cheap wrapper, no copy). */
  view(slot: ZombieSlot): SimulationZombie {
    this.assertSlot(slot);
    return new SimulationZombie(this, slot);
  }

  // ---- typed field accessors ----

  // Reads use `!` because assertSlot has already proven the index is in bounds (noUncheckedIndexedAccess).
  getArchetype(slot: ZombieSlot): number { this.assertSlot(slot); return this.fArchetype[slot]!; }
  setArchetype(slot: ZombieSlot, v: number): void { this.assertSlot(slot); this.fArchetype[slot] = v; }

  getPosition(slot: ZombieSlot, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    this.assertSlot(slot);
    const b = slot * 3;
    out[0] = this.fPosition[b]!; out[1] = this.fPosition[b + 1]!; out[2] = this.fPosition[b + 2]!;
    return out;
  }
  setPosition(slot: ZombieSlot, x: number, y: number, z: number): void {
    this.assertSlot(slot);
    const b = slot * 3;
    this.fPosition[b] = x; this.fPosition[b + 1] = y; this.fPosition[b + 2] = z;
  }

  getHeading(slot: ZombieSlot): number { this.assertSlot(slot); return this.fHeading[slot]!; }
  setHeading(slot: ZombieSlot, v: number): void { this.assertSlot(slot); this.fHeading[slot] = v; }

  getVelocity(slot: ZombieSlot, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    this.assertSlot(slot);
    const b = slot * 3;
    out[0] = this.fVelocity[b]!; out[1] = this.fVelocity[b + 1]!; out[2] = this.fVelocity[b + 2]!;
    return out;
  }
  setVelocity(slot: ZombieSlot, x: number, y: number, z: number): void {
    this.assertSlot(slot);
    const b = slot * 3;
    this.fVelocity[b] = x; this.fVelocity[b + 1] = y; this.fVelocity[b + 2] = z;
  }

  getState(slot: ZombieSlot): number { this.assertSlot(slot); return this.fState[slot]!; }
  setState(slot: ZombieSlot, v: number): void { this.assertSlot(slot); this.fState[slot] = v; }

  getStateTimer(slot: ZombieSlot): number { this.assertSlot(slot); return this.fStateTimer[slot]!; }
  setStateTimer(slot: ZombieSlot, v: number): void { this.assertSlot(slot); this.fStateTimer[slot] = v; }

  getHealth(slot: ZombieSlot): number { this.assertSlot(slot); return this.fHealth[slot]!; }
  setHealth(slot: ZombieSlot, v: number): void { this.assertSlot(slot); this.fHealth[slot] = v; }

  getAnatomyFlags(slot: ZombieSlot): number { this.assertSlot(slot); return this.fAnatomyFlags[slot]!; }
  setAnatomyFlags(slot: ZombieSlot, v: number): void { this.assertSlot(slot); this.fAnatomyFlags[slot] = v >>> 0; }

  getTarget(slot: ZombieSlot): number { this.assertSlot(slot); return this.fTarget[slot]!; }
  setTarget(slot: ZombieSlot, v: number): void { this.assertSlot(slot); this.fTarget[slot] = v; }

  getStimulus(slot: ZombieSlot): number { this.assertSlot(slot); return this.fStimulus[slot]!; }
  setStimulus(slot: ZombieSlot, v: number): void { this.assertSlot(slot); this.fStimulus[slot] = v; }

  getChunk(slot: ZombieSlot): number { this.assertSlot(slot); return this.fChunk[slot]!; }
  setChunk(slot: ZombieSlot, v: number): void { this.assertSlot(slot); this.fChunk[slot] = v; }

  getSpatialCell(slot: ZombieSlot): number { this.assertSlot(slot); return this.fSpatialCell[slot]!; }
  setSpatialCell(slot: ZombieSlot, v: number): void { this.assertSlot(slot); this.fSpatialCell[slot] = v; }

  getNavGroup(slot: ZombieSlot): number { this.assertSlot(slot); return this.fNavGroup[slot]!; }
  setNavGroup(slot: ZombieSlot, v: number): void { this.assertSlot(slot); this.fNavGroup[slot] = v; }

  getSimTier(slot: ZombieSlot): number { this.assertSlot(slot); return this.fSimTier[slot]!; }
  setSimTier(slot: ZombieSlot, v: number): void { this.assertSlot(slot); this.fSimTier[slot] = v; }

  getRenderTier(slot: ZombieSlot): number { this.assertSlot(slot); return this.fRenderTier[slot]!; }
  setRenderTier(slot: ZombieSlot, v: number): void { this.assertSlot(slot); this.fRenderTier[slot] = v; }

  getAnimState(slot: ZombieSlot): number { this.assertSlot(slot); return this.fAnimState[slot]!; }
  setAnimState(slot: ZombieSlot, v: number): void { this.assertSlot(slot); this.fAnimState[slot] = v; }

  getAnimPhase(slot: ZombieSlot): number { this.assertSlot(slot); return this.fAnimPhase[slot]!; }
  setAnimPhase(slot: ZombieSlot, v: number): void { this.assertSlot(slot); this.fAnimPhase[slot] = v; }

  private resetSlot(slot: number): void {
    const b = slot * 3;
    this.fArchetype[slot] = 0;
    this.fPosition[b] = 0; this.fPosition[b + 1] = 0; this.fPosition[b + 2] = 0;
    this.fHeading[slot] = 0;
    this.fVelocity[b] = 0; this.fVelocity[b + 1] = 0; this.fVelocity[b + 2] = 0;
    this.fState[slot] = 0;
    this.fStateTimer[slot] = 0;
    this.fHealth[slot] = 0;
    this.fAnatomyFlags[slot] = 0;
    this.fTarget[slot] = -1;
    this.fStimulus[slot] = -1;
    this.fChunk[slot] = -1;
    this.fSpatialCell[slot] = -1;
    this.fNavGroup[slot] = -1;
    this.fSimTier[slot] = 3;
    this.fRenderTier[slot] = 3;
    this.fAnimState[slot] = 0;
    this.fAnimPhase[slot] = 0;
  }

  private assertSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this._capacity) {
      throw new Error(`zombie slot ${slot} out of range [0, ${this._capacity})`);
    }
  }
}

/**
 * Ownership-named per-entity accessor view (V26 / §I). Reads + writes the SoA at a fixed slot.
 * It is a window onto authority, not a copy: mutating it mutates the store.
 */
export class SimulationZombie {
  constructor(private readonly store: SimulationZombies, readonly slot: ZombieSlot) {}

  get alive(): boolean { return this.store.isAlive(this.slot); }
  get archetype(): number { return this.store.getArchetype(this.slot); }
  set archetype(v: number) { this.store.setArchetype(this.slot, v); }

  get heading(): number { return this.store.getHeading(this.slot); }
  set heading(v: number) { this.store.setHeading(this.slot, v); }

  get health(): number { return this.store.getHealth(this.slot); }
  set health(v: number) { this.store.setHealth(this.slot, v); }

  get state(): number { return this.store.getState(this.slot); }
  set state(v: number) { this.store.setState(this.slot, v); }

  get anatomyFlags(): number { return this.store.getAnatomyFlags(this.slot); }
  set anatomyFlags(v: number) { this.store.setAnatomyFlags(this.slot, v); }

  get target(): number { return this.store.getTarget(this.slot); }
  set target(v: number) { this.store.setTarget(this.slot, v); }

  get simTier(): number { return this.store.getSimTier(this.slot); }
  set simTier(v: number) { this.store.setSimTier(this.slot, v); }

  get renderTier(): number { return this.store.getRenderTier(this.slot); }
  set renderTier(v: number) { this.store.setRenderTier(this.slot, v); }

  get navGroup(): number { return this.store.getNavGroup(this.slot); }
  set navGroup(v: number) { this.store.setNavGroup(this.slot, v); }

  position(out?: [number, number, number]): [number, number, number] {
    return this.store.getPosition(this.slot, out);
  }
  setPosition(x: number, y: number, z: number): void {
    this.store.setPosition(this.slot, x, y, z);
  }
}
