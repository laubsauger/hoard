// Wave-2 shared (coordinator-owned, frozen for the wave) / V14 / V28.
// Bounded active-stimulus store. Producers (audio, combat, fire, destruction) emit; consumers
// (behavior/perception) query attenuated intensity at a point. No omniscient coords (V14):
// behavior only ever learns about the world through stimuli reaching its position.

import type { Stimulus } from '../core/contracts/stimulus';

export interface StimulusHit {
  readonly stimulus: Stimulus;
  /** Attenuated intensity actually reaching the query point (>0). */
  readonly intensity: number;
}

export class StimulusField {
  private readonly active: Stimulus[] = [];
  private readonly cap: number;
  private _droppedCount = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`StimulusField capacity must be a positive integer, got ${capacity}`);
    }
    this.cap = capacity;
  }

  get activeCount(): number {
    return this.active.length;
  }

  /** Stimuli rejected/evicted due to capacity since construction (diagnostics). */
  get droppedCount(): number {
    return this._droppedCount;
  }

  /** Current remaining intensity at a stimulus origin given the tick. */
  private remainingAtOrigin(s: Stimulus, tick: number): number {
    const elapsed = tick - s.bornTick;
    return s.intensity - s.decayPerTick * elapsed;
  }

  /** Emit a stimulus. When full, evicts the weakest currently-active one if this one is stronger. */
  emit(stimulus: Stimulus, tick: number): boolean {
    if (this.active.length < this.cap) {
      this.active.push(stimulus);
      return true;
    }
    // Find weakest active to consider eviction.
    let weakestIdx = 0;
    let weakest = this.remainingAtOrigin(this.active[0]!, tick);
    for (let i = 1; i < this.active.length; i++) {
      const r = this.remainingAtOrigin(this.active[i]!, tick);
      if (r < weakest) {
        weakest = r;
        weakestIdx = i;
      }
    }
    if (this.remainingAtOrigin(stimulus, tick) > weakest) {
      this.active[weakestIdx] = stimulus;
      this._droppedCount += 1; // the evicted one
      return true;
    }
    this._droppedCount += 1; // the rejected new one
    return false;
  }

  /** Retire fully-decayed stimuli. Call on the perception cadence. */
  update(tick: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.remainingAtOrigin(this.active[i]!, tick) <= 0) {
        // swap-remove (order irrelevant)
        const last = this.active.pop()!;
        if (i < this.active.length) this.active[i] = last;
      }
    }
  }

  /**
   * Stimuli reaching (x,z) with positive attenuated intensity. Linear distance falloff within radius
   * combined with time decay. Returns matches; allocates only the result array.
   */
  query(x: number, z: number, tick: number): StimulusHit[] {
    const hits: StimulusHit[] = [];
    for (const s of this.active) {
      const remaining = this.remainingAtOrigin(s, tick);
      if (remaining <= 0) continue;
      const dx = x - s.x;
      const dz = z - s.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= s.radius) continue;
      const falloff = 1 - dist / s.radius;
      const reach = remaining * falloff;
      if (reach > 0) hits.push({ stimulus: s, intensity: reach });
    }
    return hits;
  }

  clear(): void {
    this.active.length = 0;
  }
}
