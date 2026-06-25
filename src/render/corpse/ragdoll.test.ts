// T134 / V2 — unit tests for the PURE ORIENTED-RIGID-BODY death ragdoll (src/render/corpse/ragdoll.ts). The sim
// is headless (no three / no GPU), so we exercise it directly on a synthetic standing-humanoid seed pose: the
// point-to-point joints hold their shared anchors coincident across many steps, the body settles ABOVE the ground
// (no sink, no NaN) with real thickness, a larger force ends up farther from the death spot, the same seed+inputs
// reproduce the same fall (V26), and at rest Δ≈identity ⇒ the emitted bone matrices equal M0.

import { describe, it, expect } from 'vitest';
import {
  Ragdoll,
  buildRagdollSpec,
  mulberry32,
  RAGDOLL_BODIES,
  RAGDOLL_JOINTS,
  RP,
  type RagdollConfig,
  type RagdollSpec,
} from './ragdoll';

const CFG: RagdollConfig = {
  gravity: 16,
  linearDamping: 0.5,
  internalLinearDamping: 6,
  angularDamping: 4.5,
  tumbleDamping: 1.2,
  jointAngularDamping: 0.12,
  groundAngularDamping: 7,
  groundRestitution: 0.03,
  groundFriction: 0.6,
  constraintIterations: 2,
  substeps: 10,
  impulseScale: 0.32,
  torqueScale: 0.45,
  settleEnergyThreshold: 0.08,
  settleSpeed: 0.12,
  torsoRadius: 0.17,
  headRadius: 0.11,
  limbRadius: 0.075,
  spineLimit: 0.14,
  neckLimit: 1.7,
  shoulderLimit: 1.4,
  hipLimit: 1.1,
  hingeSwingLimit: 0.3,
  elbowMax: 2.4,
  kneeMax: 2.4,
  trunkStiffness: 0.7,
  trunkIterations: 6,
  maxLinearSpeed: 14,
  maxAngularSpeed: 22,
  explodeSpeed: 28,
};

/** A small deterministic non-identity quaternion for body `i` (axis-angle), to exercise the orientation-dependent
 *  paths (world inverse-inertia, the cone limit's relative-orientation math) that an identity-rest spec would not. */
function tiltQuat(i: number): readonly [number, number, number, number] {
  const ang = 0.5 + 0.2 * i;
  const ax = Math.sin(i * 1.3), ay = Math.cos(i * 0.7), az = Math.sin(i * 0.4 + 1);
  const m = Math.hypot(ax, ay, az) || 1;
  const s = Math.sin(ang / 2);
  return [(ax / m) * s, (ay / m) * s, (az / m) * s, Math.cos(ang / 2)] as const;
}

// A plausible upright humanoid (meters, feet near y=0, +Z forward), particle order matching RP in ragdoll.ts.
const SEED = new Float32Array([
  0.0, 1.0, 0.0, // pelvis
  0.0, 1.35, 0.0, // chest
  0.0, 1.7, 0.0, // head
  0.18, 1.45, 0.0, // shoulderL
  0.3, 1.15, 0.0, // elbowL
  0.32, 0.9, 0.0, // handL
  -0.18, 1.45, 0.0, // shoulderR
  -0.3, 1.15, 0.0, // elbowR
  -0.32, 0.9, 0.0, // handR
  0.1, 0.95, 0.0, // hipL
  0.1, 0.5, 0.0, // kneeL
  0.1, 0.06, 0.0, // footL
  -0.1, 0.95, 0.0, // hipR
  -0.1, 0.5, 0.0, // kneeR
  -0.1, 0.06, 0.0, // footR
]);

const BONE_COUNT = RAGDOLL_BODIES.length;

function identityBones(n: number): Float32Array {
  const m = new Float32Array(n * 16);
  for (let b = 0; b < n; b++) {
    m[b * 16] = 1;
    m[b * 16 + 5] = 1;
    m[b * 16 + 10] = 1;
    m[b * 16 + 15] = 1;
  }
  return m;
}

function buildTestSpec(tilt = false): RagdollSpec {
  // Each body carries ONE identity bone (the bone matrices are not under test; the rigid-body sim is). The rest
  // frame is (seed position of the body's capStart particle, identity or a tilted orientation) — any rigid rest
  // frame makes Δ = I at rest, so the emitted matrices equal M0 (identity). `tilt` exercises the orientation paths.
  const m0 = identityBones(BONE_COUNT);
  const bodies = RAGDOLL_BODIES.map((bd, i) => ({
    bones: [i],
    capStart: bd.capStart,
    capEnd: bd.capEnd,
    sizeClass: bd.sizeClass,
    restPos: [SEED[bd.capStart * 3]!, SEED[bd.capStart * 3 + 1]!, SEED[bd.capStart * 3 + 2]!] as const,
    restQuat: tilt ? tiltQuat(i) : ([0, 0, 0, 1] as const),
  }));
  return buildRagdollSpec({ boneCount: BONE_COUNT, seed: SEED.slice(), m0, bodies, joints: RAGDOLL_JOINTS }, CFG);
}

/** Max pairwise distance between body centres — a collapsed (spaghetti/blob) ragdoll has near-zero extent. */
function bodyExtent(rag: Ragdoll): number {
  let m = 0;
  for (let i = 0; i < rag.spec.bodyCount; i++)
    for (let j = i + 1; j < rag.spec.bodyCount; j++)
      m = Math.max(m, Math.hypot(rag.c[i * 3]! - rag.c[j * 3]!, rag.c[i * 3 + 1]! - rag.c[j * 3 + 1]!, rag.c[i * 3 + 2]! - rag.c[j * 3 + 2]!));
  return m;
}

/** Total kinetic proxy Σ(|v|²+|ω|²) over all bodies. */
function kinetic(rag: Ragdoll): number {
  let e = 0;
  for (let i = 0; i < rag.spec.bodyCount; i++) {
    e += rag.v[i * 3]! ** 2 + rag.v[i * 3 + 1]! ** 2 + rag.v[i * 3 + 2]! ** 2;
    e += rag.w[i * 3]! ** 2 + rag.w[i * 3 + 1]! ** 2 + rag.w[i * 3 + 2]! ** 2;
  }
  return e;
}

/** Rotate (vx,vy,vz) by the quaternion at q[off]. */
function rot(q: Float64Array, off: number, vx: number, vy: number, vz: number): [number, number, number] {
  const x = q[off]!, y = q[off + 1]!, z = q[off + 2]!, w = q[off + 3]!;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

/** Max gap (m) between any joint's parent + child world anchors. */
function maxJointGap(rag: Ragdoll): number {
  let gap = 0;
  for (const j of rag.spec.joints) {
    const rp = rot(rag.q, j.parent * 4, j.anchorParent[0], j.anchorParent[1], j.anchorParent[2]);
    const rc = rot(rag.q, j.child * 4, j.anchorChild[0], j.anchorChild[1], j.anchorChild[2]);
    const apx = rag.c[j.parent * 3]! + rp[0];
    const apy = rag.c[j.parent * 3 + 1]! + rp[1];
    const apz = rag.c[j.parent * 3 + 2]! + rp[2];
    const acx = rag.c[j.child * 3]! + rc[0];
    const acy = rag.c[j.child * 3 + 1]! + rc[1];
    const acz = rag.c[j.child * 3 + 2]! + rc[2];
    gap = Math.max(gap, Math.hypot(acx - apx, acy - apy, acz - apz));
  }
  return gap;
}

function run(force: number, dirX: number, dirZ: number, seed: number, maxSteps = 3000, tilt = false): Ragdoll {
  const spec = buildTestSpec(tilt);
  const rag = new Ragdoll(spec);
  rag.reset(spec, CFG, dirX, dirZ, force, mulberry32(seed));
  for (let i = 0; i < maxSteps && !rag.settled; i++) rag.step(CFG, 1 / 60);
  return rag;
}

function allFinite(a: Float32Array | Float64Array): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]!)) return false;
  return true;
}

function maxBodyY(rag: Ragdoll): number {
  let maxY = 0;
  for (let i = 0; i < rag.spec.bodyCount; i++) maxY = Math.max(maxY, rag.c[i * 3 + 1]!);
  return maxY;
}

/** Hamilton product of two [x,y,z,w] quats. */
function qmul(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  return [
    a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!,
    a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!,
    a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!,
    a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!,
  ];
}

/** Signed twist (rad) of joint `ji` about its hinge axis — the same swing-twist measure the limit solver uses.
 *  For a knee/elbow hinge a negative twist past −hingeSwingLimit is the FORBIDDEN backward bend. */
function jointTwist(rag: Ragdoll, ji: number): number {
  const j = rag.spec.joints[ji]!;
  const p = j.parent, c = j.child;
  const qp = [rag.q[p * 4]!, rag.q[p * 4 + 1]!, rag.q[p * 4 + 2]!, rag.q[p * 4 + 3]!];
  const qc = [rag.q[c * 4]!, rag.q[c * 4 + 1]!, rag.q[c * 4 + 2]!, rag.q[c * 4 + 3]!];
  const qpInv = [-qp[0]!, -qp[1]!, -qp[2]!, qp[3]!];
  const qrel = qmul(qpInv, qc);
  const rr = j.restRel;
  const rrInv = [-rr[0]!, -rr[1]!, -rr[2]!, rr[3]!];
  let err = qmul(rrInv, qrel);
  if (err[3]! < 0) err = [-err[0]!, -err[1]!, -err[2]!, -err[3]!];
  const ax = j.hingeAxis;
  const proj = err[0]! * ax[0]! + err[1]! * ax[1]! + err[2]! * ax[2]!;
  return 2 * Math.atan2(proj, err[3]!);
}

/** Joint indices that are one-way hinges (knee/elbow), matching the spec.joints order (= RAGDOLL_JOINTS order). */
const HINGE_JOINTS = RAGDOLL_JOINTS.map((j, i) => ({ i, k: j.limit }))
  .filter((x) => x.k === 'knee' || x.k === 'elbow')
  .map((x) => x.i);

/** Total rotation angle (rad) of joint `ji`'s relative orientation away from its rest — how far the child has rotated
 *  relative to the parent. The stiff trunk keeps this tiny; a limb joint opens it wide. */
function jointRelAngle(rag: Ragdoll, ji: number): number {
  const j = rag.spec.joints[ji]!;
  const qp = [rag.q[j.parent * 4]!, rag.q[j.parent * 4 + 1]!, rag.q[j.parent * 4 + 2]!, rag.q[j.parent * 4 + 3]!];
  const qc = [rag.q[j.child * 4]!, rag.q[j.child * 4 + 1]!, rag.q[j.child * 4 + 2]!, rag.q[j.child * 4 + 3]!];
  const qpInv = [-qp[0]!, -qp[1]!, -qp[2]!, qp[3]!];
  const qrel = qmul(qpInv, qc);
  const rr = j.restRel;
  const rrInv = [-rr[0]!, -rr[1]!, -rr[2]!, rr[3]!];
  const err = qmul(rrInv, qrel);
  let w = Math.abs(err[3]!);
  if (w > 1) w = 1;
  return 2 * Math.acos(w);
}

/** (mass-weighted COM speed, max per-body RESIDUAL speed) — the residual is each body's velocity minus the whole-body
 *  rigid prediction (vcom + ωavg×r), i.e. exactly the non-rigid limb-flail the decoupled damping bleeds hard. */
function comAndResidual(rag: Ragdoll): { com: number; res: number } {
  const B = rag.spec.bodyCount;
  let mx = 0, my = 0, mz = 0, mm = 0, cx = 0, cy = 0, cz = 0;
  let wx = 0, wy = 0, wz = 0;
  for (let i = 0; i < B; i++) {
    const m = 1 / rag.spec.invMass[i]!;
    mm += m;
    mx += m * rag.v[i * 3]!; my += m * rag.v[i * 3 + 1]!; mz += m * rag.v[i * 3 + 2]!;
    cx += m * rag.c[i * 3]!; cy += m * rag.c[i * 3 + 1]!; cz += m * rag.c[i * 3 + 2]!;
    wx += rag.w[i * 3]!; wy += rag.w[i * 3 + 1]!; wz += rag.w[i * 3 + 2]!;
  }
  mx /= mm; my /= mm; mz /= mm; cx /= mm; cy /= mm; cz /= mm;
  wx /= B; wy /= B; wz /= B;
  let res = 0;
  for (let i = 0; i < B; i++) {
    const rx = rag.c[i * 3]! - cx, ry = rag.c[i * 3 + 1]! - cy, rz = rag.c[i * 3 + 2]! - cz;
    const px = mx + (wy * rz - wz * ry), py = my + (wz * rx - wx * rz), pz = mz + (wx * ry - wy * rx);
    res = Math.max(res, Math.hypot(rag.v[i * 3]! - px, rag.v[i * 3 + 1]! - py, rag.v[i * 3 + 2]! - pz));
  }
  return { com: Math.hypot(mx, my, mz), res };
}

describe('ragdoll sim (oriented rigid bodies)', () => {
  it('holds point-to-point joints coincident across many steps', () => {
    const spec = buildTestSpec();
    const rag = new Ragdoll(spec);
    rag.reset(spec, CFG, 1, 0, 40, mulberry32(123));
    for (let i = 0; i < 1500; i++) rag.step(CFG, 1 / 60);
    // Joints are PBD-soft but must not pull apart — a few cm at most.
    expect(maxJointGap(rag)).toBeLessThan(0.06);
  });

  it('settles to rest above the ground (no sink, no NaN) within a bounded time', () => {
    const rag = run(30, 1, 0, 7);
    expect(rag.settled).toBe(true);
    expect(allFinite(rag.c)).toBe(true);
    expect(allFinite(rag.q)).toBe(true);
    // Every body rests with its capsule ABOVE the floor (centre at or above ~half the ground radius — bodies sit
    // on their radius, so a centre can dip toward the radius but never plunge below the surface).
    for (let i = 0; i < rag.spec.bodyCount; i++) {
      expect(rag.c[i * 3 + 1]!).toBeGreaterThan(-0.02);
    }
    // A settled body lies low — its highest body centre is well below standing height (1.7 m).
    expect(maxBodyY(rag)).toBeLessThan(0.9);
  });

  it('keeps the prone trunk OFF the floor (thickness — no pancake)', () => {
    const rag = run(20, 0, 1, 11);
    expect(rag.settled).toBe(true);
    // The pelvis + chest bodies rest on their capsule radius, so their centres sit clearly above y=0.
    const pelvisY = rag.c[0 * 3 + 1]!;
    const chestY = rag.c[1 * 3 + 1]!;
    expect(pelvisY).toBeGreaterThan(0.03);
    expect(chestY).toBeGreaterThan(0.03);
  });

  it('does NOT collapse to a point (retains body extent — no blob/spaghetti)', () => {
    const restSpec = buildTestSpec();
    const restRag = new Ragdoll(restSpec);
    restRag.reset(restSpec, CFG, 0, 0, 0, mulberry32(1)); // seeds c from the rest pose
    expect(bodyExtent(restRag)).toBeGreaterThan(0.7); // ~0.9 m at the standing rest pose

    const rag = run(20, 1, 0, 3);
    // A settled humanoid still spans a good fraction of its rest extent — never converges to a single point.
    expect(bodyExtent(rag)).toBeGreaterThan(0.4);
  });

  it('stays STABLE + settles with NON-trivial rest orientations (the orientation paths do not pump energy)', () => {
    // Tilted rest frames exercise world inverse-inertia + the cone limit's relative-orientation math — a buggy
    // (energy-pumping) cone would leave the body vibrating at the velocity clamp instead of settling.
    const rag = run(40, 0.5, 0.5, 314, 3000, true);
    expect(rag.settled).toBe(true);
    expect(allFinite(rag.c)).toBe(true);
    expect(allFinite(rag.q)).toBe(true);
    expect(kinetic(rag)).toBeLessThan(CFG.settleEnergyThreshold);
    expect(bodyExtent(rag)).toBeGreaterThan(0.4); // coherent, not collapsed
  });

  it('knockback scales with force — a larger hit ends up farther from the death spot', () => {
    const restX = SEED[RP.pelvis * 3]!;
    const restZ = SEED[RP.pelvis * 3 + 2]!;
    const disp = (rag: Ragdoll): number => Math.hypot(rag.c[0]! - restX, rag.c[2]! - restZ);
    const light = disp(run(8, 1, 0, 42));
    const heavy = disp(run(120, 1, 0, 42));
    expect(heavy).toBeGreaterThan(light);
  });

  it('never produces NaN — body transforms + emitted bone matrices stay finite', () => {
    const spec = buildTestSpec();
    const rag = new Ragdoll(spec);
    rag.reset(spec, CFG, 0.7, -0.7, 300, mulberry32(99)); // huge force, diagonal hit
    const out = new Float32Array(spec.boneCount * 16);
    for (let i = 0; i < 400; i++) {
      rag.step(CFG, 1 / 60);
      rag.writeBones(out, 0);
      expect(allFinite(rag.c)).toBe(true);
      expect(allFinite(rag.q)).toBe(true);
      expect(allFinite(out)).toBe(true);
    }
  });

  it('is deterministic — same seed + inputs reproduce the same fall', () => {
    const a = run(80, 0.3, 0.9, 2024, 500);
    const b = run(80, 0.3, 0.9, 2024, 500);
    expect(a.settled).toBe(b.settled);
    for (let i = 0; i < a.c.length; i++) expect(a.c[i]!).toBeCloseTo(b.c[i]!, 10);
    for (let i = 0; i < a.q.length; i++) expect(a.q[i]!).toBeCloseTo(b.q[i]!, 10);
  });

  it('at rest Δ ≈ identity ⇒ the emitted bone matrices equal M0 (exact standing idle, frame 0)', () => {
    const spec = buildTestSpec();
    const rag = new Ragdoll(spec);
    rag.reset(spec, CFG, 0, 0, 0, mulberry32(1));
    const out = new Float32Array(spec.boneCount * 16);
    rag.writeBones(out, 0); // BEFORE any step — rest pose
    for (let i = 0; i < out.length; i++) expect(out[i]!).toBeCloseTo(spec.m0[i]!, 5);
  });

  it('a force-less death still crumples (settles low) under gravity', () => {
    const rag = run(0, 0, 0, 5);
    expect(rag.settled).toBe(true);
    expect(maxBodyY(rag)).toBeLessThan(1.1); // crumpled, not standing
  });

  it('knees + elbows never bend the WRONG way (one-way hinge holds across the fall)', () => {
    // Drive hard falls in several directions/seeds (the cases that most load the leg/arm hinges) + watch every
    // hinge each step. The position-only backstop keeps the backward overshoot small and bounded.
    let minTwist = Infinity;
    for (const [sx, sz, seed] of [[0, 1, 77], [1, 0, 3], [0.6, 0.8, 42]] as const) {
      const spec = buildTestSpec();
      const rag = new Ragdoll(spec);
      rag.reset(spec, CFG, sx, sz, 40, mulberry32(seed));
      for (let i = 0; i < 1500 && !rag.settled; i++) {
        rag.step(CFG, 1 / 60);
        for (const ji of HINGE_JOINTS) minTwist = Math.min(minTwist, jointTwist(rag, ji));
      }
    }
    // twistLo = −hingeSwingLimit; the soft velocity backstop allows a small transient overshoot under a violent
    // impact but the hinge NEVER bends meaningfully backward (a hyperextended knee/elbow reads as a large negative
    // twist — e.g. −π/2). This bound (~−0.9 rad) catches any real wrong-way fold while tolerating the overshoot.
    expect(minTwist).toBeGreaterThan(-(CFG.hingeSwingLimit + 0.6));
  });

  it('a settled body keeps real VERTICAL extent — bulky, not pancaked', () => {
    const rag = run(20, 1, 0, 11);
    expect(rag.settled).toBe(true);
    // The highest body centre rests on the fat TORSO radius, not flattened to the thin-limb floor → has bulk.
    expect(maxBodyY(rag)).toBeGreaterThan(CFG.torsoRadius * 0.7);
  });

  it('a forward shot TRAVELS forward — COM lands ahead of the in-place gravity crumple', () => {
    // Average pelvis Z over several seeds: the forward shot drives a consistent +Z travel, while the gravity
    // crumple's faint random tip averages out to ≈ in place (each seed tips a different way).
    let fwdSum = 0, gravSum = 0;
    const seeds = [21, 5, 88, 314];
    for (const seed of seeds) {
      fwdSum += run(16, 0, 1, seed).c[2]!; // shot forward (+Z)
      gravSum += run(0, 0, 0, seed).c[2]!; // gravity only — crumples roughly in place
    }
    expect(fwdSum / seeds.length).toBeGreaterThan(gravSum / seeds.length + 0.3);
  });

  it('a bigger forward force lands FARTHER forward', () => {
    const light = run(4, 0, 1, 33);
    const heavy = run(14, 0, 1, 33);
    expect(heavy.c[2]!).toBeGreaterThan(light.c[2]!);
  });

  it('NEVER sinks below the floor — across many seeds, directions, and a hard awkward shot', () => {
    // The hard floor clamp + explosion backstop must hold every step: no body centre dips below the plane and the
    // capsules rest on their radius (a centre cannot go negative). Stress a wide matrix incl. a violent shot.
    const dirs: readonly (readonly [number, number])[] = [[0, 1], [1, 0], [0, -1], [0.7, 0.7], [-0.6, 0.5]];
    for (const force of [0, 4, 13, 20, 40]) {
      for (const [dx, dz] of dirs) {
        for (const seed of [1, 7, 33, 99, 2024]) {
          const spec = buildTestSpec();
          const rag = new Ragdoll(spec);
          rag.reset(spec, CFG, dx, dz, force, mulberry32(seed));
          for (let i = 0; i < 1200 && !rag.settled; i++) {
            rag.step(CFG, 1 / 60);
            for (let b = 0; b < rag.spec.bodyCount; b++) {
              expect(rag.c[b * 3 + 1]!).toBeGreaterThan(-1e-6); // never below the floor plane
              expect(Number.isFinite(rag.c[b * 3 + 1]!)).toBe(true); // never explodes to non-finite
            }
          }
        }
      }
    }
  });

  it('STIFF TRUNK — the chest barely rotates relative to the pelvis (rigid board), far less than a limb joint', () => {
    const spineJi = RAGDOLL_JOINTS.findIndex((j) => j.limit === 'spine');
    const elbowJi = RAGDOLL_JOINTS.findIndex((j) => j.limit === 'elbow');
    const hipJi = RAGDOLL_JOINTS.findIndex((j) => j.limit === 'hip');
    let maxSpine = 0, maxElbow = 0, maxHip = 0;
    for (const [sx, sz, seed] of [[0, 1, 7], [1, 0, 3], [0, -1, 42], [0.6, 0.8, 99]] as const) {
      const spec = buildTestSpec();
      const rag = new Ragdoll(spec);
      rag.reset(spec, CFG, sx, sz, 40, mulberry32(seed));
      for (let i = 0; i < 1200 && !rag.settled; i++) {
        rag.step(CFG, 1 / 60);
        maxSpine = Math.max(maxSpine, jointRelAngle(rag, spineJi));
        maxElbow = Math.max(maxElbow, jointRelAngle(rag, elbowJi));
        maxHip = Math.max(maxHip, jointRelAngle(rag, hipJi));
      }
    }
    // The trunk stays within a tight angular spread (the tight spine limit + trunk coupling + extra iterations).
    expect(maxSpine).toBeLessThan(0.6);
    // …and it is markedly STIFFER than the articulating limb joints.
    expect(maxSpine).toBeLessThan(maxElbow);
    expect(maxSpine).toBeLessThan(maxHip);
  });

  it('DECOUPLED damping — the non-rigid residual (limb flail) decays faster than the COM translation', () => {
    // Airborne after a forward shot: the residual velocity (deviation from the whole-body rigid motion) is bled HARD
    // while the common COM translation is bled LIGHTLY → a stiff body whose knockback keeps travelling.
    const spec = buildTestSpec();
    const rag = new Ragdoll(spec);
    rag.reset(spec, CFG, 0, 1, 10, mulberry32(5));
    rag.step(CFG, 1 / 60);
    rag.step(CFG, 1 / 60);
    const a = comAndResidual(rag); // early (still airborne)
    for (let i = 0; i < 6; i++) rag.step(CFG, 1 / 60);
    const b = comAndResidual(rag); // a few frames later, before landing
    // Residual collapses to a small fraction; the COM speed is nearly preserved.
    expect(b.res / a.res).toBeLessThan(0.7);
    expect(b.com / a.com).toBeGreaterThan(0.85);
    // The residual decays by a strictly larger fraction than the COM translation (the decouple).
    expect(b.res / a.res).toBeLessThan(b.com / a.com);
  });
});
