// T128 / V2 / V3 — RIGGED crowd animation tables + clip→state mapping (pure).
// The bone-texture bake + TSL skinning need a GPU and are CDP-verified; this asserts only the PURE bits:
// the clip→state map (incl. that every mapped clip exists in the archetype's GLB), the frame-table layout,
// and the phase→row + phase-advance math.

import { describe, it, expect } from 'vitest';
import { ZombieState } from '../../game/simulation';
import {
  ARCHETYPE_KEYS,
  CLIP_MAPS,
  archetypeKeyForIndex,
  bakeClipNames,
  clipForState,
  buildClipTable,
  phaseToFrameRow,
  clipPhaseRateHz,
  advancePhase,
  isFrozenIdle,
  isLocomotionState,
  locomotionRateHz,
  MAX_GAIT_RATE_HZ,
  GAIT_CYCLES_PER_METER,
  type ClipStateMap,
} from './riggedAnim';

/** The ACTUAL clip names shipped in each GLB (`public/meshes/zombie-*.glb`, from the T127 handout). */
const GLB_CLIPS: Record<string, readonly string[]> = {
  standard: ['Hit_Reaction_to_Waist', 'Idle_9', 'Running', 'Unsteady_Walk', 'Walking', 'Zombie_Scream', 'run_fast_8'],
  runner: ['Casual_Walk', 'Running', 'Walking', 'run_fast_2'],
  bloated: ['Idle_5', 'Idle_9', 'Running', 'Slow_Orc_Walk', 'Unsteady_Walk', 'Walking'],
};

describe('archetypeKeyForIndex', () => {
  it('maps the spawned registry indices to their GLB keys, ecology variants fall back to standard', () => {
    expect(archetypeKeyForIndex(0)).toBe('standard'); // shambler
    expect(archetypeKeyForIndex(1)).toBe('runner');
    expect(archetypeKeyForIndex(6)).toBe('bloated');
    for (const i of [2, 3, 4, 5]) expect(archetypeKeyForIndex(i)).toBe('standard'); // crawler/armored/decayed/burned
    expect(archetypeKeyForIndex(99)).toBe('standard'); // out-of-roster → safe default
  });
});

describe('CLIP_MAPS', () => {
  it('every mapped clip exists in that archetype GLB clip set', () => {
    for (const key of ARCHETYPE_KEYS) {
      const map = CLIP_MAPS[key];
      const available = GLB_CLIPS[key]!;
      for (const state of Object.values(map)) {
        if (typeof state !== 'string') continue; // skip non-clip-name flags (e.g. idleFrozen)
        expect(available, `${key}:${state}`).toContain(state);
      }
    }
  });

  it('freezes the RUNNER idle (no real idle clip → Casual_Walk fallback) but not standard/bloated', () => {
    expect(isFrozenIdle(CLIP_MAPS.runner, ZombieState.Idle)).toBe(true); // would otherwise walk on the spot
    expect(isFrozenIdle(CLIP_MAPS.standard, ZombieState.Idle)).toBe(false); // has Idle_9
    expect(isFrozenIdle(CLIP_MAPS.bloated, ZombieState.Idle)).toBe(false); // has Idle_5
    expect(isFrozenIdle(CLIP_MAPS.runner, ZombieState.Wander)).toBe(false); // only Idle freezes; moving cycles
  });

  it('clipForState routes each ZombieState to the configured clip', () => {
    const map: ClipStateMap = CLIP_MAPS.standard;
    expect(clipForState(map, ZombieState.Idle)).toBe(map.idle);
    expect(clipForState(map, ZombieState.Wander)).toBe(map.wander);
    expect(clipForState(map, ZombieState.Pursue)).toBe(map.pursue);
    expect(clipForState(map, ZombieState.Attack)).toBe(map.attack);
    expect(clipForState(map, ZombieState.Stagger)).toBe(map.stagger);
    expect(clipForState(map, ZombieState.Down)).toBe(map.down);
    expect(clipForState(map, 255)).toBe(map.idle); // unknown → idle
  });

  it('bakeClipNames is the deduped union of an archetype state map', () => {
    // standard maps Idle_9 twice (idle + down) → deduped
    const names = bakeClipNames('standard');
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('Idle_9');
    expect(names).toContain('Zombie_Scream');
    expect(names.filter((n) => n === 'Idle_9')).toHaveLength(1);
  });
});

describe('buildClipTable', () => {
  it('lays clips out as contiguous row ranges and sums to totalRows', () => {
    const table = buildClipTable(
      [
        { name: 'a', frameCount: 10 },
        { name: 'b', frameCount: 5 },
        { name: 'c', frameCount: 7 },
      ],
      30,
    );
    expect(table.entries.get('a')).toEqual({ startRow: 0, frameCount: 10, fps: 30 });
    expect(table.entries.get('b')).toEqual({ startRow: 10, frameCount: 5, fps: 30 });
    expect(table.entries.get('c')).toEqual({ startRow: 15, frameCount: 7, fps: 30 });
    expect(table.totalRows).toBe(22);
    expect(table.fps).toBe(30);
  });

  it('throws on a non-positive fps or frameCount (V4, no silent zero-row clip)', () => {
    expect(() => buildClipTable([{ name: 'a', frameCount: 4 }], 0)).toThrow();
    expect(() => buildClipTable([{ name: 'a', frameCount: 0 }], 30)).toThrow();
    expect(() => buildClipTable([{ name: 'a', frameCount: 2.5 }], 30)).toThrow();
  });
});

describe('phaseToFrameRow', () => {
  const entry = { startRow: 100, frameCount: 10, fps: 30 };
  it('maps phase 0..1 into the clip frame range, offset by startRow', () => {
    expect(phaseToFrameRow(entry, 0)).toBe(100);
    expect(phaseToFrameRow(entry, 0.05)).toBe(100); // floor(0.5) = 0
    expect(phaseToFrameRow(entry, 0.15)).toBe(101); // floor(1.5) = 1
    expect(phaseToFrameRow(entry, 0.99)).toBe(109); // floor(9.9) = 9
  });
  it('clamps the boundary phase to the last frame (never spills into the next clip)', () => {
    expect(phaseToFrameRow(entry, 1)).toBe(109);
    expect(phaseToFrameRow(entry, 1.5)).toBe(109);
    expect(phaseToFrameRow(entry, -0.2)).toBe(100);
  });
});

describe('clipPhaseRateHz', () => {
  it('is one loop per clip duration (fps / frameCount)', () => {
    expect(clipPhaseRateHz({ startRow: 0, frameCount: 30, fps: 30 })).toBeCloseTo(1); // 1s clip → 1 Hz
    expect(clipPhaseRateHz({ startRow: 0, frameCount: 15, fps: 30 })).toBeCloseTo(2); // 0.5s clip → 2 Hz
  });
});

describe('isLocomotionState', () => {
  it('is true only for Wander + Pursue', () => {
    expect(isLocomotionState(ZombieState.Wander)).toBe(true);
    expect(isLocomotionState(ZombieState.Pursue)).toBe(true);
    expect(isLocomotionState(ZombieState.Idle)).toBe(false);
    expect(isLocomotionState(ZombieState.Attack)).toBe(false);
    expect(isLocomotionState(ZombieState.Stagger)).toBe(false);
    expect(isLocomotionState(ZombieState.Down)).toBe(false);
  });
});

describe('locomotionRateHz', () => {
  const natural = 2; // a fast natural clip rate to prove locomotion overrides it
  it('non-locomotion / near-stopped plays at the natural clip rate (idle still animates)', () => {
    expect(locomotionRateHz(false, 5, 1.5, natural)).toBe(natural);
    expect(locomotionRateHz(true, 0, 1.5, natural)).toBe(natural); // stopped
  });
  it('a moving locomotion clip WITH a baked stride paces cadence to speed / stride (foot match)', () => {
    expect(locomotionRateHz(true, 3, 1.5, natural)).toBeCloseTo(2); // 3 m/s over a 1.5 m stride → 2 cycles/s
    // a SLOW mover on a stride clip cadences slowly (fixes the "run anim too fast for the movement" report)
    expect(locomotionRateHz(true, 0.6, 1.5, 5)).toBeCloseTo(0.4);
  });
  it('an in-place clip (tiny stride) falls back to the nominal cycles-per-metre pace', () => {
    expect(locomotionRateHz(true, 2, 0.05, natural)).toBeCloseTo(2 * GAIT_CYCLES_PER_METER);
  });
  it('clamps a very fast mover to MAX_GAIT_RATE_HZ', () => {
    expect(locomotionRateHz(true, 100, 1.5, natural)).toBe(MAX_GAIT_RATE_HZ);
  });
});

describe('advancePhase', () => {
  it('advances by rate·dt and wraps to [0,1)', () => {
    expect(advancePhase(0, 1, 0.25)).toBeCloseTo(0.25);
    expect(advancePhase(0.9, 1, 0.25)).toBeCloseTo(0.15); // wrapped
    expect(advancePhase(0, 2, 1)).toBeCloseTo(0); // 2 full loops
  });
  it('is deterministic and stays in [0,1)', () => {
    let p = 0.37;
    for (let i = 0; i < 1000; i++) {
      p = advancePhase(p, 1.7, 1 / 60);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });
});
