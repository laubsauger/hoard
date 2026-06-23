// PLAYER PERCEPTION v2 (V62) — RENDER-side reveal combination + recently-seen memory. NO sim state: this lives
// entirely in the view layer, fed by frame dt, and is NEVER read back into the deterministic sim (V26 untouched —
// no id counters, no RNG). The crowd fog-of-war reveal for a zombie is the MAX of four independent terms:
//
//   revealVisibility = max(coneReveal, nearReveal, memoryReveal, noiseReveal)
//
//   • coneReveal   — the existing forward vision wedge (cone + range + edge bands + structural LOS), via
//                    `visionCullFade`. One unchanged term.
//   • nearReveal   — proximity awareness: a zombie within `nearRadiusMeters` is revealed regardless of cone
//                    DIRECTION, but still requires structural line-of-sight (you sense what's beside you, not
//                    through a solid wall).
//   • noiseReveal  — a LOUD zombie (Pursue/Attack) within `hearingRange` is (partially) revealed even with no
//                    LOS, attenuated by `soundWallOcclusion` when a wall blocks the path (you HEAR it).
//   • memoryReveal — a zombie that WAS revealed stays revealed, fading 1→0 over `memorySeconds` after it leaves
//                    view (the stateful `PerceptionMemory` below).
//
// CRITICAL INVARIANT (V63): every LOS test routes through the injected `lineOfSight` callback, which the scene
// wires to the STRUCTURAL `hasLineOfSight` (nav/structural grid). This NEVER consults mesh opacity/visibility, so
// fading a wall for the cutaway (a pure view aid) can NOT reveal the zombies structurally behind it.

import { visionCullFade, type VisionCull } from './visionCull';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Cone wedge params (the existing VisionCull) PLUS the v2 near/noise reveal params. */
export interface RevealParams extends VisionCull {
  /** Proximity awareness radius (m): a zombie within it is revealed regardless of cone direction (LOS still gates). */
  readonly nearRadiusMeters: number;
  /** Hearing range (m) for the noise-awareness term. */
  readonly hearingRange: number;
  /** Intensity multiplier applied to a HEARD zombie whose path to the player is wall-occluded (0..1). */
  readonly soundWallOcclusion: number;
}

/**
 * Instantaneous (memory-free) reveal at (x,z): max(cone, near, noise). `loud` = the zombie is in an active/loud
 * state (Pursue/Attack). Pure; the only world coupling is the structural `lineOfSight` callback on the params.
 */
export function instantaneousReveal(x: number, z: number, loud: boolean, p: RevealParams): number {
  // Cone term — the unchanged forward wedge (cone + range + edge bands + LOS).
  const cone = visionCullFade(x, z, p);

  const dx = x - p.px;
  const dz = z - p.pz;
  const dist = Math.hypot(dx, dz);
  const clearLos = !p.lineOfSight || p.lineOfSight(p.px, p.pz, x, z);

  // Near term — revealed regardless of cone direction within the radius, but only with structural LOS.
  const near = dist <= p.nearRadiusMeters && clearLos ? 1 : 0;

  // Noise term — a loud zombie within hearing is (partially) revealed even without LOS, attenuated through walls.
  let noise = 0;
  if (loud && p.hearingRange > 0 && dist <= p.hearingRange) {
    const falloff = clamp01(1 - dist / p.hearingRange);
    noise = clearLos ? falloff : falloff * p.soundWallOcclusion;
  }

  return Math.max(cone, near, noise);
}

/**
 * RENDER-side recently-seen memory (V62): a per-slot last-seen reveal that fades 1→0 over `memorySeconds` once a
 * zombie leaves view. `peak` is the reveal value captured when the slot was last at-or-above its decaying memory;
 * `age` is the seconds since. Stepping a slot with a higher instantaneous reveal REFRESHES it (peak=inst, age=0);
 * a lower one AGES it and returns the decayed value. Dead/unseen slots simply decay to 0. Allocated once to the
 * SoA capacity — no per-frame allocation (V24). This is view state only; nothing flows back into the sim (V26).
 */
export class PerceptionMemory {
  private readonly peak: Float32Array;
  private readonly age: Float32Array;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) throw new Error(`capacity must be a non-negative integer, got ${capacity}`);
    this.peak = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
  }

  /** Advance slot `slot` by `dt` against its instantaneous reveal `inst`; returns the memory-blended reveal. */
  step(slot: number, inst: number, dt: number, memorySeconds: number): number {
    const decayed = memorySeconds > 0 ? this.peak[slot]! * Math.max(0, 1 - this.age[slot]! / memorySeconds) : 0;
    if (inst >= decayed) {
      this.peak[slot] = inst;
      this.age[slot] = 0;
      return inst;
    }
    const nextAge = this.age[slot]! + Math.max(0, dt);
    this.age[slot] = nextAge;
    return memorySeconds > 0 ? this.peak[slot]! * Math.max(0, 1 - nextAge / memorySeconds) : 0;
  }
}
