// T134 — unit tests for the PURE per-limb death ragdoll (src/render/corpse/ragdoll.ts). The sim is headless (no
// three / no GPU), so we exercise it directly on a synthetic standing-humanoid seed pose: bone lengths hold across
// many steps, the body settles above the ground (no sink, no NaN), a larger force knocks it back farther, and the
// same seed+inputs reproduce the same fall (V26).

import { describe, it, expect } from 'vitest';
import {
  Ragdoll,
  buildRagdollSpec,
  mulberry32,
  RAGDOLL_PARTICLE_COUNT,
  RAGDOLL_SEGMENT_BONES,
  RAGDOLL_LINKS,
  RAGDOLL_CONES,
  type RagdollConfig,
  type RagdollSpec,
} from './ragdoll';

const CFG: RagdollConfig = {
  gravity: 14,
  linearDamping: 0.6,
  angularDamping: 4,
  groundRestitution: 0.12,
  groundFriction: 0.5,
  constraintIterations: 8,
  substeps: 3,
  impulseScale: 0.06,
  torqueScale: 2.5,
  settleEnergyThreshold: 4e-7,
  jointConeRadians: 0.6,
  groundRadiusMeters: 0.09,
};

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

function buildTestSpec(): RagdollSpec {
  // One identity bone per segment (the bone matrices are not under test here; the particle sim is).
  const boneCount = RAGDOLL_SEGMENT_BONES.length;
  const m0 = new Float32Array(boneCount * 16);
  for (let b = 0; b < boneCount; b++) {
    m0[b * 16] = 1;
    m0[b * 16 + 5] = 1;
    m0[b * 16 + 10] = 1;
    m0[b * 16 + 15] = 1;
  }
  const segments = RAGDOLL_SEGMENT_BONES.map((s, i) => ({
    anchor: s.anchor,
    dirFrom: s.dirFrom,
    dirTo: s.dirTo,
    bones: [i],
  }));
  return buildRagdollSpec(
    {
      particleCount: RAGDOLL_PARTICLE_COUNT,
      boneCount,
      seed: SEED.slice(),
      m0,
      links: RAGDOLL_LINKS,
      coneTriples: RAGDOLL_CONES,
      segments,
    },
    CFG.jointConeRadians,
  );
}

function run(force: number, dirX: number, dirZ: number, seed: number, maxSteps = 2400): Ragdoll {
  const spec = buildTestSpec();
  const rag = new Ragdoll(spec);
  rag.reset(spec, CFG, dirX, dirZ, force, mulberry32(seed));
  for (let i = 0; i < maxSteps && !rag.settled; i++) rag.step(CFG, 1 / 60);
  return rag;
}

function allFinite(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]!)) return false;
  return true;
}

describe('ragdoll sim', () => {
  it('holds bone (distance-constraint) lengths across many steps', () => {
    const spec = buildTestSpec();
    const rag = new Ragdoll(spec);
    rag.reset(spec, CFG, 1, 0, 80, mulberry32(123));
    for (let i = 0; i < 1200; i++) rag.step(CFG, 1 / 60);
    for (const con of spec.constraints) {
      const bi = con.i * 3;
      const bj = con.j * 3;
      const d = Math.hypot(rag.pos[bj]! - rag.pos[bi]!, rag.pos[bj + 1]! - rag.pos[bi + 1]!, rag.pos[bj + 2]! - rag.pos[bi + 2]!);
      // Verlet constraints are soft, but bones must not drift apart — within a few % of rest length.
      expect(Math.abs(d - con.rest)).toBeLessThan(con.rest * 0.08 + 0.01);
    }
  });

  it('settles to rest above the ground (no sink, no NaN) within a bounded time', () => {
    const rag = run(60, 1, 0, 7);
    expect(rag.settled).toBe(true);
    expect(allFinite(rag.pos)).toBe(true);
    // Every particle rests AT or ABOVE the ground radius (a hair of tolerance for the soft constraint push).
    for (let p = 0; p < RAGDOLL_PARTICLE_COUNT; p++) {
      expect(rag.pos[p * 3 + 1]!).toBeGreaterThan(CFG.groundRadiusMeters - 0.02);
    }
    // A settled body lies low — its highest point is well below standing height.
    let maxY = 0;
    for (let p = 0; p < RAGDOLL_PARTICLE_COUNT; p++) maxY = Math.max(maxY, rag.pos[p * 3 + 1]!);
    expect(maxY).toBeLessThan(1.0);
  });

  it('knockback scales with force — a larger hit ends up farther from the death spot', () => {
    const seedPelvisX = SEED[0]!;
    const seedPelvisZ = SEED[2]!;
    const disp = (rag: Ragdoll): number => Math.hypot(rag.pos[0]! - seedPelvisX, rag.pos[2]! - seedPelvisZ);
    const light = disp(run(15, 1, 0, 42));
    const heavy = disp(run(220, 1, 0, 42));
    expect(heavy).toBeGreaterThan(light);
  });

  it('never produces NaN — positions and emitted bone matrices stay finite', () => {
    const spec = buildTestSpec();
    const rag = new Ragdoll(spec);
    rag.reset(spec, CFG, 0.7, -0.7, 500, mulberry32(99)); // huge force, diagonal hit
    const out = new Float32Array(spec.boneCount * 16);
    for (let i = 0; i < 300; i++) {
      rag.step(CFG, 1 / 60);
      rag.writeBones(out, 0);
      expect(allFinite(rag.pos)).toBe(true);
      expect(allFinite(out)).toBe(true);
    }
  });

  it('is deterministic — same seed + inputs reproduce the same fall', () => {
    const a = run(120, 0.3, 0.9, 2024, 400);
    const b = run(120, 0.3, 0.9, 2024, 400);
    expect(a.settled).toBe(b.settled);
    for (let i = 0; i < a.pos.length; i++) expect(a.pos[i]!).toBeCloseTo(b.pos[i]!, 10);
  });

  it('a force-less death still collapses (settles low) under gravity', () => {
    const rag = run(0, 0, 0, 5);
    expect(rag.settled).toBe(true);
    let maxY = 0;
    for (let p = 0; p < RAGDOLL_PARTICLE_COUNT; p++) maxY = Math.max(maxY, rag.pos[p * 3 + 1]!);
    expect(maxY).toBeLessThan(1.2); // crumpled, not standing
  });
});
