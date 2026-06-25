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
  linearDamping: 1.1,
  angularDamping: 2.5,
  groundRestitution: 0.03,
  groundFriction: 1.3,
  constraintIterations: 2,
  substeps: 10,
  impulseScale: 0.42,
  torqueScale: 0.18,
  settleEnergyThreshold: 0.05,
  jointConeRadians: 1.5,
  groundRadiusMeters: 0.11,
  capsuleRadiusMeters: 0.12,
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
});
