// T128 / V2 / V3 — RIGGED crowd animation tables + clip→state mapping (PURE CPU core, no three/GPU).
// The near-band crowd (hero + active-crowd tiers) is drawn as REAL rigged GLB meshes (one InstancedMesh per
// archetype) skinned ON THE GPU from a baked BONE-MATRIX ANIMATION TEXTURE (see `rigged.ts`). This module owns
// the GPU-free, unit-testable parts: (a) the per-archetype clip→ZombieState map, (b) the frame TABLE math that
// lays each baked clip's frames out as contiguous rows in the bone texture, and (c) the per-instance phase →
// texture-row math the packer uses each frame. Reads nothing from three; pure + deterministic (V26).

import { ZombieState } from '../../game/simulation';

/** The three rigged archetypes that ship as GLB skinned meshes. Standard is the dominant/default. */
export type ArchetypeKey = 'standard' | 'runner' | 'bloated';

/** Every rigged archetype key, in load/registration order. */
export const ARCHETYPE_KEYS: readonly ArchetypeKey[] = ['standard', 'runner', 'bloated'];

/**
 * Map a SoA `archetype` registry index to its rigged GLB key. Registry order (T124/V89) is
 * `[shambler(0), runner(1), crawler(2), armored(3), decayed(4), burned(5), bloated(6)]`. Only the three
 * SPAWNED archetypes (shambler/runner/bloated) have dedicated GLBs; the zero-spawn-weight ecology variants
 * (crawler/armored/decayed/burned) reuse the STANDARD humanoid rig so an enabled variant still renders rigged.
 */
export function archetypeKeyForIndex(index: number): ArchetypeKey {
  switch (index) {
    case 1:
      return 'runner';
    case 6:
      return 'bloated';
    default:
      return 'standard';
  }
}

/** Per-archetype ZombieState → clip-NAME map. Names MUST exist in that archetype's GLB clip set (verified in test). */
export interface ClipStateMap {
  readonly idle: string;
  readonly wander: string;
  readonly pursue: string;
  readonly attack: string;
  readonly stagger: string;
  readonly down: string;
}

/**
 * Clip→state maps per archetype, picked from each GLB's clip list (T127 handout). Locomotion states map to the
 * matching gait; Attack uses the most aggressive available tell (scream for standard; a fast/agitated cycle for
 * the others, which lack a dedicated attack/scream clip); Stagger uses the hit reaction where present (standard)
 * else an unsteady cycle. Down reuses an idle. Standard is the DOMINANT archetype.
 */
export const CLIP_MAPS: Readonly<Record<ArchetypeKey, ClipStateMap>> = {
  // standard: Idle_9 / Walking / Unsteady_Walk / Running / run_fast_8 / Zombie_Scream / Hit_Reaction_to_Waist
  standard: { idle: 'Idle_9', wander: 'Walking', pursue: 'Running', attack: 'Zombie_Scream', stagger: 'Hit_Reaction_to_Waist', down: 'Idle_9' },
  // runner: Casual_Walk / Walking / Running / run_fast_2 (no idle/hit/scream clip)
  runner: { idle: 'Casual_Walk', wander: 'Walking', pursue: 'run_fast_2', attack: 'Running', stagger: 'Walking', down: 'Casual_Walk' },
  // bloated: Idle_5 / Idle_9 / Slow_Orc_Walk / Unsteady_Walk / Walking / Running (no hit/scream clip)
  bloated: { idle: 'Idle_5', wander: 'Slow_Orc_Walk', pursue: 'Running', attack: 'Unsteady_Walk', stagger: 'Unsteady_Walk', down: 'Idle_9' },
};

/** The UNIQUE clip names an archetype needs baked (dedup of its state map) — the bake-list for `rigged.ts`. */
export function bakeClipNames(key: ArchetypeKey): string[] {
  const m = CLIP_MAPS[key];
  return [...new Set([m.idle, m.wander, m.pursue, m.attack, m.stagger, m.down])];
}

/** PURE ZombieState → clip name for an archetype (unit-tested). Idle/unknown fall through to the idle clip. */
export function clipForState(map: ClipStateMap, state: number): string {
  switch (state) {
    case ZombieState.Wander:
      return map.wander;
    case ZombieState.Pursue:
      return map.pursue;
    case ZombieState.Attack:
      return map.attack;
    case ZombieState.Stagger:
      return map.stagger;
    case ZombieState.Down:
      return map.down;
    case ZombieState.Idle:
    default:
      return map.idle;
  }
}

/** One clip's frame range inside the bone texture: `frameCount` rows starting at row `startRow`, sampled at `fps`. */
export interface ClipTableEntry {
  readonly startRow: number;
  readonly frameCount: number;
  readonly fps: number;
}

/** Per-archetype clip table: name → row range, plus the total row count (= bone-texture height). */
export interface ClipTable {
  readonly entries: ReadonlyMap<string, ClipTableEntry>;
  readonly totalRows: number;
  readonly fps: number;
}

/** A baked clip's frame count (rows it occupies in the bone texture). */
export interface ClipFrameSpec {
  readonly name: string;
  readonly frameCount: number;
}

/**
 * Lay each clip's frames out as contiguous rows in the bone texture: clip k starts at the running sum of the
 * previous clips' frame counts. PURE — same specs+fps always yield the same table (V26). Throws on a
 * non-positive fps / frameCount (V4 — no silent zero-row clip).
 */
export function buildClipTable(specs: readonly ClipFrameSpec[], fps: number): ClipTable {
  if (!(fps > 0)) throw new Error(`bake fps must be positive, got ${fps}`);
  const entries = new Map<string, ClipTableEntry>();
  let startRow = 0;
  for (const s of specs) {
    if (!Number.isInteger(s.frameCount) || s.frameCount <= 0) {
      throw new Error(`clip '${s.name}' frameCount must be a positive integer, got ${s.frameCount}`);
    }
    entries.set(s.name, { startRow, frameCount: s.frameCount, fps });
    startRow += s.frameCount;
  }
  return { entries, totalRows: startRow, fps };
}

/** Absolute bone-texture ROW for a normalized phase ∈ [0,1) within a clip. Clamps the frame into the clip range. */
export function phaseToFrameRow(entry: ClipTableEntry, phase: number): number {
  const f = Math.floor(phase * entry.frameCount);
  const clamped = f < 0 ? 0 : f >= entry.frameCount ? entry.frameCount - 1 : f;
  return entry.startRow + clamped;
}

/** Natural loop rate (Hz) for a clip — one full cycle per clip duration, so it plays at its authored speed. */
export function clipPhaseRateHz(entry: ClipTableEntry): number {
  return entry.fps / entry.frameCount;
}

/** Nominal gait cycles per metre travelled, used to pace IN-PLACE locomotion clips (no baked root stride). */
export const GAIT_CYCLES_PER_METER = 0.55;
/** Below this planar speed (m/s) a locomotion clip plays at its NATURAL rate (avoids freezing a momentarily-stopped mover). */
export const MIN_LOCOMOTION_SPEED = 0.05;
/** A baked clip stride below this (m) is treated as IN-PLACE (no usable root motion) → fall back to the nominal pace. */
export const MIN_STRIDE_METERS = 0.3;
/** Upper clamp on the baked stride used for cadence (m). An EXAGGERATED leaping clip (e.g. the runner's
 *  `run_fast_2` bakes a ~7.7 m bound) would otherwise give cadence = speed/7.7 ≈ a SLOW-MOTION crawl at any
 *  believable zombie speed. Capping the effective stride keeps the legs cycling at a run-like rate (a hair of
 *  foot-slide is far less jarring than slow-mo). Normal walk/run clips (stride ≲ this) are unaffected. */
export const MAX_STRIDE_METERS = 2.4;
/** Clamp on the speed-coupled cadence (Hz) so a fast mover's legs never blur into a buzz. */
export const MAX_GAIT_RATE_HZ = 4;

/** Whether a ZombieState is LOCOMOTION (the gait cadence should track ground speed) vs a stationary/one-off pose. */
export function isLocomotionState(state: number): boolean {
  return state === ZombieState.Wander || state === ZombieState.Pursue;
}

/**
 * Phase rate (Hz) that keeps the gait cadence MATCHED to the member's ground speed so the feet don't slide or
 * windmill (T128). For a moving locomotion state: if the clip baked a real forward STRIDE (root motion), one
 * cycle covers `strideMeters` of ground, so cadence = speed / stride (exact foot match); for an in-place clip
 * (no root stride) fall back to the nominal `GAIT_CYCLES_PER_METER`. Stationary / one-off states (idle/attack/
 * stagger/down) and near-stopped movers play at the clip's NATURAL rate. Clamped to `MAX_GAIT_RATE_HZ`. PURE.
 */
export function locomotionRateHz(isLocomotion: boolean, speed: number, strideMeters: number, naturalRateHz: number): number {
  if (!isLocomotion || speed <= MIN_LOCOMOTION_SPEED) return naturalRateHz;
  // Cap an exaggerated baked stride so a leaping clip doesn't slow-mo at zombie speeds (see MAX_STRIDE_METERS).
  const effStride = Math.min(strideMeters, MAX_STRIDE_METERS);
  const rate = effStride > MIN_STRIDE_METERS ? speed / effStride : speed * GAIT_CYCLES_PER_METER;
  return Math.min(rate, MAX_GAIT_RATE_HZ);
}

/** Advance a normalized phase by `rateHz·dt` and wrap to [0,1). PURE; dt should be >= 0 (guarded against negatives). */
export function advancePhase(phase: number, rateHz: number, dtSeconds: number): number {
  let p = phase + rateHz * dtSeconds;
  p -= Math.floor(p);
  return p < 0 ? p + 1 : p;
}
