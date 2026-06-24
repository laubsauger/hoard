// T72 / V2 / V3 / V13 / V17 / T111 / V75 — pure block-limbed crowd core: tier selection, pool cap,
// sever-hide, per-instance transform composition, and the STATE-DRIVEN gait (idle/walk/chase/attack).
// No GPU/three; runs on plain typed arrays + the frozen SoA.

import { describe, it, expect } from 'vitest';
import { allocateSoa, ZOMBIE_FIELDS } from '../../game/core/contracts/soa';
import { ZombieState } from '../../game/simulation';
import { regionBit } from '../../game/combat/anatomy';
import {
  packLimbInputs,
  composeLimbMatrix,
  walkSwing,
  walkBob,
  limbGait,
  gaitPhaseRateHz,
  stateReachTarget,
  FLOATS_PER_LIMB_POSE,
  FLOATS_PER_MAT4,
  type LimbPartPlacement,
  type LimbGait,
  type LimbGaitConfig,
} from './limbs';

const CAP = 8;

/** Reference gait config (mirrors the rendering-config defaults) for the pure-function tests. */
const GAIT: LimbGaitConfig = {
  idleSwingRadians: 0.05,
  walkSwingRadians: 0.45,
  chaseSwingRadians: 0.85,
  idleFreqHz: 0.4,
  walkFreqHz: 1.4,
  chaseFreqHz: 2.6,
  idleBobMeters: 0.012,
  walkBobMeters: 0.05,
  chaseBobMeters: 0.12,
  attackReachRadians: 1.05,
  chaseReachRadians: 0.7,
  attackFreqHz: 3.2,
  reachBlendHz: 6,
  speedRefMetersPerSecond: 2.5,
};

function makeSoa() {
  const soa = allocateSoa(ZOMBIE_FIELDS, CAP);
  return {
    soa,
    alive: soa.views['alive'] as Uint8Array,
    position: soa.views['position'] as Float32Array,
    heading: soa.views['heading'] as Float32Array,
    velocity: soa.views['velocity'] as Float32Array,
    simTier: soa.views['simTier'] as Uint8Array,
    state: soa.views['state'] as Uint8Array,
    anatomyFlags: soa.views['anatomyFlags'] as Uint32Array,
    animPhase: soa.views['animPhase'] as Float32Array,
  };
}

function out(cap: number) {
  return {
    pose: new Float32Array(cap * FLOATS_PER_LIMB_POSE),
    scale: new Float32Array(cap),
    anatomy: new Uint32Array(cap),
    phase: new Float32Array(cap),
    state: new Uint8Array(cap),
    speed: new Float32Array(cap),
    reach: new Float32Array(cap),
    slot: new Float32Array(cap),
  };
}

const OPTS = { variationCount: 1, scaleMin: 1, scaleMax: 1, maxSimTier: 1, dtSeconds: 0, gait: GAIT } as const;

/** Call packLimbInputs with fresh per-slot phase + reach accumulators sized to the scanned slot count, threading
 *  the reach/slot outputs (T122/V87) so tests can assert them. */
function pack(
  views: ReturnType<typeof makeSoa>['soa']['views'],
  o: ReturnType<typeof out>,
  opts: Parameters<typeof packLimbInputs>[9],
  phaseState: Float32Array = new Float32Array(opts.count),
  reachState: Float32Array = new Float32Array(opts.count),
) {
  return packLimbInputs(views, o.pose, o.scale, o.anatomy, o.phase, o.state, o.speed, phaseState, reachState, {
    ...opts,
    outReach: opts.outReach ?? o.reach,
    outSlot: opts.outSlot ?? o.slot,
  });
}

describe('packLimbInputs — tier selection (V13)', () => {
  it('promotes only hero/active tiers (simTier <= maxSimTier); horde/abstract are skipped', () => {
    const s = makeSoa();
    // slot 0 hero, 1 active -> limbed; slot 2 horde, 3 abstract -> NOT limbed (box draws those).
    for (let i = 0; i < 4; i++) {
      s.alive[i] = 1;
      s.simTier[i] = i as 0 | 1 | 2 | 3;
      s.position[i * 3] = i; // x = slot for identity check
    }
    const o = out(CAP);
    const res = pack(s.soa.views, o, { count: 4, capacity: CAP, ...OPTS });
    expect(res.liveCount).toBe(2);
    // Compacted to the front: instance 0 = slot 0 (x=0), instance 1 = slot 1 (x=1).
    expect(o.pose[0]).toBeCloseTo(0, 6);
    expect(o.pose[FLOATS_PER_LIMB_POSE]).toBeCloseTo(1, 6);
  });

  it('skips dead slots even within the limbed tier band', () => {
    const s = makeSoa();
    s.alive[0] = 0; // dead hero
    s.alive[1] = 1;
    s.simTier[1] = 1;
    const o = out(CAP);
    const res = pack(s.soa.views, o, { count: 2, capacity: CAP, ...OPTS });
    expect(res.liveCount).toBe(1);
  });

  it('caps at the limbed budget (pool cap, no throw)', () => {
    const s = makeSoa();
    for (let i = 0; i < CAP; i++) {
      s.alive[i] = 1;
      s.simTier[i] = 0;
    }
    const budget = 3;
    const o = out(budget);
    const res = pack(s.soa.views, o, { count: CAP, capacity: budget, ...OPTS });
    expect(res.liveCount).toBe(budget);
  });

  it('passes anatomyFlags, state, and speed through per instance', () => {
    const s = makeSoa();
    s.alive[0] = 1;
    s.simTier[0] = 0;
    const flags = regionBit('armLeft') | regionBit('legRight');
    s.anatomyFlags[0] = flags;
    s.state[0] = ZombieState.Pursue;
    s.velocity[0] = 3; // vx
    s.velocity[2] = 4; // vz → speed = 5
    const o = out(CAP);
    pack(s.soa.views, o, { count: 1, capacity: CAP, ...OPTS });
    expect(o.anatomy[0]).toBe(flags);
    expect(o.state[0]).toBe(ZombieState.Pursue);
    expect(o.speed[0]).toBeCloseTo(5, 6);
  });

  it('advances each slot phase at the per-state rate, persisting across frames (T111/V75)', () => {
    const s = makeSoa();
    s.alive[0] = 1;
    s.simTier[0] = 0;
    s.state[0] = ZombieState.Pursue;
    s.velocity[0] = GAIT.speedRefMetersPerSecond; // full speed → chase rate (2.6 Hz)
    const o = out(CAP);
    const phaseState = new Float32Array(CAP); // seeded 0
    const opts = { count: 1, capacity: CAP, ...OPTS, dtSeconds: 0.5 };
    pack(s.soa.views, o, opts, phaseState);
    expect(o.phase[0]).toBeCloseTo(0.3, 5); // 2.6*0.5 = 1.3 → fract 0.3
    pack(s.soa.views, o, opts, phaseState);
    expect(o.phase[0]).toBeCloseTo(0.6, 5); // 1.3 + 1.3 = 2.6 → fract 0.6 (accumulator persists per slot)
  });

  it('vision-cone cull hides figures outside the wedge (T98)', () => {
    const s = makeSoa();
    // slot 0 ahead (visible), slot 1 behind (hidden by the cone).
    s.alive[0] = 1; s.simTier[0] = 0; s.position[0] = 5; s.position[2] = 0;
    s.alive[1] = 1; s.simTier[1] = 0; s.position[1 * 3] = -5; s.position[1 * 3 + 2] = 0;
    const o = out(CAP);
    const res = pack(s.soa.views, o, {
      count: 2,
      capacity: CAP,
      ...OPTS,
      visibility: { px: 0, pz: 0, heading: 0, fovHalf: Math.PI / 4, range: 20, edgeBandMeters: 0, edgeBandRadians: 0 },
    });
    expect(res.liveCount).toBe(1);
    expect(o.pose[0]).toBeCloseTo(5, 6);
  });

  it('over-budget figures fall through (continue, not break) so later slots still rank correctly', () => {
    // 3 limbed-eligible slots, budget 2: the first 2 become figures; the 3rd is left for the box path. The
    // ranking must keep counting past the cap (continue), matching packCrowdInputs' figureRank.
    const s = makeSoa();
    for (let i = 0; i < 3; i++) { s.alive[i] = 1; s.simTier[i] = 0; s.position[i * 3] = i; }
    const o = out(2);
    const res = pack(s.soa.views, o, { count: 3, capacity: 2, ...OPTS });
    expect(res.liveCount).toBe(2);
    expect(o.pose[0]).toBeCloseTo(0, 6);
    expect(o.pose[FLOATS_PER_LIMB_POSE]).toBeCloseTo(1, 6);
  });
});

describe('limbGait — state-driven swing/bob/reach (T111/V75)', () => {
  const fresh = (): LimbGait => ({ swing: 0, bob: 0, reach: 0 });

  it('idle is near-still: swing within the idle band, no reach', () => {
    const r = limbGait(fresh(), ZombieState.Idle, 0, 0.25, GAIT);
    expect(Math.abs(r.swing)).toBeLessThanOrEqual(GAIT.idleSwingRadians + 1e-9);
    expect(r.reach).toBe(0);
  });

  it('chase swing exceeds walk swing exceeds idle swing at full speed + same phase', () => {
    const ref = GAIT.speedRefMetersPerSecond;
    const idle = limbGait(fresh(), ZombieState.Idle, 0, 0.25, GAIT);
    const walk = limbGait(fresh(), ZombieState.Wander, ref, 0.25, GAIT);
    const chase = limbGait(fresh(), ZombieState.Pursue, ref, 0.25, GAIT);
    expect(Math.abs(chase.swing)).toBeGreaterThan(Math.abs(walk.swing));
    expect(Math.abs(walk.swing)).toBeGreaterThan(Math.abs(idle.swing));
  });

  it('chase bob is deeper than walk bob at full speed', () => {
    const ref = GAIT.speedRefMetersPerSecond;
    const walk = limbGait(fresh(), ZombieState.Wander, ref, 0.25, GAIT);
    const chase = limbGait(fresh(), ZombieState.Pursue, ref, 0.25, GAIT);
    expect(chase.bob).toBeGreaterThan(walk.bob);
  });

  it('locomotion swing scales with speed (a crawl swings less than a sprint)', () => {
    const slow = limbGait(fresh(), ZombieState.Wander, 0.25 * GAIT.speedRefMetersPerSecond, 0.25, GAIT);
    const fast = limbGait(fresh(), ZombieState.Wander, GAIT.speedRefMetersPerSecond, 0.25, GAIT);
    expect(Math.abs(fast.swing)).toBeGreaterThan(Math.abs(slow.swing));
  });

  it('attack is a FORWARD arm reach, NOT the counter-swing (reach>0, legs within idle band)', () => {
    for (const phase of [0, 0.25, 0.5, 0.75]) {
      const r = limbGait(fresh(), ZombieState.Attack, 0, phase, GAIT);
      expect(r.reach).toBeGreaterThan(0); // always reaching forward through the lunge
      expect(Math.abs(r.swing)).toBeLessThanOrEqual(GAIT.idleSwingRadians + 1e-9); // legs planted
    }
  });

  it('CHASE (Pursue) raises the arms forward — a steady reach while still locomoting (T122/V87)', () => {
    const ref = GAIT.speedRefMetersPerSecond;
    for (const phase of [0, 0.25, 0.5, 0.75]) {
      const r = limbGait(fresh(), ZombieState.Pursue, ref, phase, GAIT);
      expect(r.reach).toBeGreaterThan(0); // arms reach forward through the chase
    }
    // Roaming states keep the arms down (no reach).
    expect(limbGait(fresh(), ZombieState.Wander, ref, 0.3, GAIT).reach).toBe(0);
    expect(limbGait(fresh(), ZombieState.Idle, 0, 0.3, GAIT).reach).toBe(0);
  });

  it('is deterministic — identical inputs give identical outputs', () => {
    const a = limbGait(fresh(), ZombieState.Pursue, 1.7, 0.33, GAIT);
    const b = limbGait(fresh(), ZombieState.Pursue, 1.7, 0.33, GAIT);
    expect(b).toEqual(a);
  });
});

describe('gaitPhaseRateHz — per-state stride frequency (T111/V75)', () => {
  it('chase strides faster than walk at full speed', () => {
    const ref = GAIT.speedRefMetersPerSecond;
    expect(gaitPhaseRateHz(ZombieState.Pursue, ref, GAIT)).toBeGreaterThan(
      gaitPhaseRateHz(ZombieState.Wander, ref, GAIT),
    );
  });
  it('idle ticks at the slow breathing rate; a stopped walker falls back to that floor', () => {
    expect(gaitPhaseRateHz(ZombieState.Idle, 0, GAIT)).toBeCloseTo(GAIT.idleFreqHz, 6);
    expect(gaitPhaseRateHz(ZombieState.Wander, 0, GAIT)).toBeCloseTo(GAIT.idleFreqHz, 6);
  });
  it('walk frequency scales up with speed', () => {
    expect(gaitPhaseRateHz(ZombieState.Wander, GAIT.speedRefMetersPerSecond, GAIT)).toBeGreaterThan(
      gaitPhaseRateHz(ZombieState.Wander, 0.5, GAIT),
    );
  });
});

describe('stateReachTarget — forward arm-raise target (T122/V87)', () => {
  it('chasing/attacking reach FORWARD (>0); roaming states do not (==0); stagger recoils BACK (<0)', () => {
    expect(stateReachTarget(ZombieState.Pursue, 0.3, GAIT)).toBeGreaterThan(0);
    expect(stateReachTarget(ZombieState.Attack, 0.3, GAIT)).toBeGreaterThan(0);
    expect(stateReachTarget(ZombieState.Idle, 0.3, GAIT)).toBe(0);
    expect(stateReachTarget(ZombieState.Wander, 0.3, GAIT)).toBe(0);
    expect(stateReachTarget(ZombieState.Down, 0.3, GAIT)).toBe(0);
    expect(stateReachTarget(ZombieState.Stagger, 0.3, GAIT)).toBeLessThan(0);
  });

  it('the ATTACK lunge reaches further than the steady CHASE lurch at the same phase', () => {
    expect(stateReachTarget(ZombieState.Attack, 0.25, GAIT)).toBeGreaterThan(
      stateReachTarget(ZombieState.Pursue, 0.25, GAIT),
    );
  });

  it('is deterministic — identical inputs give identical output (V26)', () => {
    expect(stateReachTarget(ZombieState.Pursue, 0.42, GAIT)).toBe(stateReachTarget(ZombieState.Pursue, 0.42, GAIT));
  });
});

describe('packLimbInputs — eased arm-raise + slot output (T122/V87)', () => {
  it('eases the per-slot reach toward the chase target over frames (no hard snap)', () => {
    const s = makeSoa();
    s.alive[0] = 1;
    s.simTier[0] = 0;
    s.state[0] = ZombieState.Pursue;
    s.velocity[0] = GAIT.speedRefMetersPerSecond; // full chase
    const o = out(CAP);
    const phaseState = new Float32Array(CAP);
    const reachState = new Float32Array(CAP); // arms start down (0)
    const opts = { count: 1, capacity: CAP, ...OPTS, dtSeconds: 1 / 30 };
    pack(s.soa.views, o, opts, phaseState, reachState);
    const after1 = o.reach[0]!;
    expect(after1).toBeGreaterThan(0); // arms begin to raise
    pack(s.soa.views, o, opts, phaseState, reachState);
    const after2 = o.reach[0]!;
    expect(after2).toBeGreaterThan(after1); // keeps easing UP toward the target (accumulator persists per slot)
  });

  it('writes the SoA slot per compacted instance (the stable tint identity)', () => {
    const s = makeSoa();
    s.alive[0] = 0; // dead → skipped
    s.alive[1] = 1; s.simTier[1] = 0;
    s.alive[2] = 1; s.simTier[2] = 0;
    const o = out(CAP);
    const res = pack(s.soa.views, o, { count: 3, capacity: CAP, ...OPTS });
    expect(res.liveCount).toBe(2);
    expect(o.slot[0]).toBe(1); // instance 0 = slot 1
    expect(o.slot[1]).toBe(2); // instance 1 = slot 2
  });
});

describe('composeLimbMatrix — transform composition (V2)', () => {
  const torso: LimbPartPlacement = { offset: [0, 1.2, 0], pivotLen: 0, swingSign: 0, reachSign: 0 };
  const armLeft: LimbPartPlacement = { offset: [-0.34, 1.2, 0], pivotLen: 0.31, swingSign: -1, reachSign: -1 };
  const armRight: LimbPartPlacement = { offset: [0.34, 1.2, 0], pivotLen: 0.31, swingSign: 1, reachSign: -1 };

  it('composes translation from position + part offset (heading 0)', () => {
    const m = new Float32Array(FLOATS_PER_MAT4);
    composeLimbMatrix(m, 0, [3, 0, -7], 0, 1, torso, 0, 0, 0, true);
    expect(m[12]).toBeCloseTo(3, 6);
    expect(m[13]).toBeCloseTo(1.2, 6); // py + offset.y
    expect(m[14]).toBeCloseTo(-7, 6);
    expect(m[15]).toBeCloseTo(1, 6);
    // facing = heading - 90°: at heading 0 the figure faces +X, so its lateral local-X axis points along world
    // -Z (shoulders PERPENDICULAR to travel — the fix for the sideways walk).
    expect(m[0]).toBeCloseTo(0, 6);
    expect(m[2]).toBeCloseTo(-1, 6);
  });

  it('faces the travel direction with shoulders perpendicular (yaw)', () => {
    const m = new Float32Array(FLOATS_PER_MAT4);
    // heading = +90deg (moving +Z): the figure FACES +Z. armRight is a +X LATERAL offset, so it stays at the
    // figure's RIGHT SIDE (world +X) — NOT swung forward (that would be the sideways-walk bug).
    composeLimbMatrix(m, 0, [0, 0, 0], Math.PI / 2, 1, armRight, 0, 0, 0, true);
    expect(m[12]).toBeCloseTo(0.34, 5); // lateral arm at +X (the side of a +Z-facing figure)
    expect(m[14]).toBeCloseTo(0, 5); // NOT forward
    // local X (lateral) maps to world +X when facing +Z.
    expect(m[0]).toBeCloseTo(1, 6);
    expect(m[2]).toBeCloseTo(0, 6);
  });

  it('applies uniform scale to the basis and offset', () => {
    const m = new Float32Array(FLOATS_PER_MAT4);
    composeLimbMatrix(m, 0, [0, 0, 0], 0, 2, torso, 0, 0, 0, true);
    expect(m[2]).toBeCloseTo(-2, 6); // scaled lateral axis (heading 0 → local X points along -Z), scaled ×2
    expect(m[13]).toBeCloseTo(2.4, 6); // offset.y * scale
  });

  it('adds the vertical walk bob to y', () => {
    const m = new Float32Array(FLOATS_PER_MAT4);
    composeLimbMatrix(m, 0, [0, 0, 0], 0, 1, torso, 0, 0, 0.1, true);
    expect(m[13]).toBeCloseTo(1.3, 6); // 1.2 + bob
  });

  it('walk counter-swings the arms (opposite local-X rotation L vs R); attack reaches BOTH forward (T111/V75)', () => {
    const ml = new Float32Array(FLOATS_PER_MAT4);
    const mr = new Float32Array(FLOATS_PER_MAT4);
    // WALK: swing only (reach 0). out[9] = -sin(sw); swingSign differs → opposite signs (counter-swing).
    composeLimbMatrix(ml, 0, [0, 0, 0], 0, 1, armLeft, 0.3, 0, 0, true);
    composeLimbMatrix(mr, 0, [0, 0, 0], 0, 1, armRight, 0.3, 0, 0, true);
    expect(Math.sign(ml[9]!)).toBe(-Math.sign(mr[9]!));
    expect(ml[9]).not.toBeCloseTo(0, 3);
    // ATTACK: reach only (swing 0). reachSign is the SAME on both arms → same-sign rotation (both reach forward).
    const al = new Float32Array(FLOATS_PER_MAT4);
    const ar = new Float32Array(FLOATS_PER_MAT4);
    composeLimbMatrix(al, 0, [0, 0, 0], 0, 1, armLeft, 0, 0.5, 0, true);
    composeLimbMatrix(ar, 0, [0, 0, 0], 0, 1, armRight, 0, 0.5, 0, true);
    expect(Math.sign(al[9]!)).toBe(Math.sign(ar[9]!));
    expect(al[9]).toBeCloseTo(ar[9]!, 6);
    // Forward reach (positive magnitude, reachSign -1 → sw<0 → sin(sw)<0 → out[9] = -sin(sw) > 0): the arm's
    // hand swings toward local +Z / the facing direction.
    expect(al[9]).toBeGreaterThan(0);
  });

  it('swings the limb about its JOINT (top of the box), not its center (T122/V87)', () => {
    const leg: LimbPartPlacement = { offset: [-0.13, 0.42, 0], pivotLen: 0.425, swingSign: 1, reachSign: 0 };
    const L = leg.pivotLen;
    const a = new Float32Array(FLOATS_PER_MAT4);
    const b = new Float32Array(FLOATS_PER_MAT4);
    composeLimbMatrix(a, 0, [0, 0, 0], 0, 1, leg, 0, 0, 0, true); // no swing
    composeLimbMatrix(b, 0, [0, 0, 0], 0, 1, leg, 0.5, 0, 0, true); // swung
    // The joint = box center (column 3) + the local +Y axis (column 1) × pivotLen. It must be ANCHORED (identical)
    // across swings — that is the definition of pivoting about the joint instead of the limb midpoint.
    const jointA = [a[12]! + a[4]! * L, a[13]! + a[5]! * L, a[14]! + a[6]! * L];
    const jointB = [b[12]! + b[4]! * L, b[13]! + b[5]! * L, b[14]! + b[6]! * L];
    expect(jointB[0]).toBeCloseTo(jointA[0]!, 6);
    expect(jointB[1]).toBeCloseTo(jointA[1]!, 6);
    expect(jointB[2]).toBeCloseTo(jointA[2]!, 6);
    // The box CENTER (translation) DOES move — the foot swings out below the fixed hip. (facing = heading − 90°,
    // so at heading 0 the limb's fore/aft swing displaces world X, i.e. column-3 element 12.)
    expect(b[12]).not.toBeCloseTo(a[12]!, 3);
  });

  it('pivotLen 0 (torso/head) keeps the plain centered translation even when swung (T122/V87)', () => {
    const rigid: LimbPartPlacement = { offset: [0, 1.2, 0], pivotLen: 0, swingSign: 1, reachSign: 0 };
    const m = new Float32Array(FLOATS_PER_MAT4);
    composeLimbMatrix(m, 0, [0, 0, 0], 0, 1, rigid, 0.5, 0, 0, true);
    expect(m[12]).toBeCloseTo(0, 6);
    expect(m[13]).toBeCloseTo(1.2, 6);
    expect(m[14]).toBeCloseTo(0, 6);
  });

  it('zeroes the whole matrix when the part is severed (dismemberment hide, V17)', () => {
    const m = new Float32Array(FLOATS_PER_MAT4).fill(9);
    composeLimbMatrix(m, 0, [1, 2, 3], 0.5, 1, armRight, 0.4, 0, 0.05, false);
    for (let i = 0; i < FLOATS_PER_MAT4; i++) expect(m[i]).toBe(0);
  });

  it('writes at the given base element offset', () => {
    const m = new Float32Array(FLOATS_PER_MAT4 * 2);
    composeLimbMatrix(m, FLOATS_PER_MAT4, [5, 0, 0], 0, 1, torso, 0, 0, 0, true);
    expect(m[FLOATS_PER_MAT4 + 12]).toBeCloseTo(5, 6);
    expect(m[FLOATS_PER_MAT4 + 15]).toBeCloseTo(1, 6);
  });
});

describe('walk-cycle helpers', () => {
  it('swing is zero at phase 0 and bounded by amplitude', () => {
    expect(walkSwing(0, 0.5)).toBeCloseTo(0, 6);
    expect(Math.abs(walkSwing(0.25, 0.5))).toBeCloseTo(0.5, 6);
  });
  it('bob is non-negative (upward gait) and bounded', () => {
    expect(walkBob(0, 0.1)).toBeCloseTo(0, 6);
    expect(walkBob(0.25, 0.1)).toBeCloseTo(0.1, 6);
    expect(walkBob(0.5, 0.1)).toBeGreaterThanOrEqual(0);
  });
});
