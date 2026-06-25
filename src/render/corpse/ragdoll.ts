// T134 / V2 / V24 — PURE, headless-testable PER-LIMB RAGDOLL for dead rigged zombies (no three / no GPU).
//
// A killed rigged corpse goes LIMP and falls under physics instead of the rigid whole-body `corpseTopple`. The
// body is modelled as a small set of ORIENTED RIGID BODIES (one per bone group: pelvis/chest/head/upper+lower
// arms/thighs+shins). Each body has a full state — center `c`, orientation quaternion `q`, linear velocity `v`,
// angular velocity `ω` — so it carries TWIST and VOLUME, the two things the old point-mass Verlet model lacked
// (a 2-point direction has no roll → random 180° flips → spaghetti, and zero thickness → every joint pins to the
// floor → pancake). Now each body is a CAPSULE that rests on its radius, and the trunk sits ABOVE the ground.
//
// SOLVER (per substep, semi-implicit Euler + PBD): integrate v,ω (gravity + damping) → integrate c,q → iterate
// point-to-point JOINT constraints (parent distal anchor must coincide with child proximal anchor — corrects BOTH
// position AND orientation via the COM→anchor lever arm, which is what makes limbs swing) + a LOOSE cone/twist
// limit (so elbows/knees/neck don't hyperextend through) → positional GROUND push-out → recompute v,ω from the
// position delta → CONTACT velocity impulses at the offset contact point (restitution + Coulomb friction, applied
// at the lever arm so a shoulder hitting the floor spins the torso → the body rolls + settles on its side/front).
//
// SPACE: the sim runs in the corpse's LOCAL output space — meters, feet near y=0, +Z forward (the bind/idle pose
// the rigged bake produces). The render layer applies the per-instance facing yaw + scale + world translate on top
// (exactly as the old frozen corpse did), so the impulse direction is rotated into this local frame by the caller.
//
// BONE READOUT: each body carries a group of GLB bones. From the body's current transform we form a rigid delta
//   Δ = mat4(c, q) · inverse(bodyRest)
// (bodyRest = the body's idle world transform, captured in the bake) and emit, per carried bone b, the live
// skinning matrix M_b = Δ · M0_b, where M0_b is the BAKED idle skinning matrix (output-local). At rest c,q come
// from bodyRest so Δ = I and M_b = M0_b → the exact frozen idle pose. Column-major throughout (matches three's
// `Matrix4.elements` / the bone DataTexture texel layout: 4 texels = 4 columns).

/** Tunables resolved from config (V4 — no magic numbers in the sim). */
export interface RagdollConfig {
  /** Downward acceleration (m/s²). A touch heavier than 9.8 for game-feel. */
  readonly gravity: number;
  /** Fraction of a body's LINEAR velocity bled per second (air drag). */
  readonly linearDamping: number;
  /** Fraction of a body's ANGULAR velocity bled per second (spin drag → settling). */
  readonly angularDamping: number;
  /** Vertical bounce kept on a ground hit (0 = dead stop, 1 = perfectly elastic). */
  readonly groundRestitution: number;
  /** Coulomb friction coefficient at a ground capsule contact (0 = frictionless). */
  readonly groundFriction: number;
  /** Joint (point + cone) solver iterations per substep (stiffer joints at higher counts). */
  readonly constraintIterations: number;
  /** Semi-implicit Euler substeps per stepped frame (stability vs cost). */
  readonly substeps: number;
  /** force → initial linear SPEED (m/s) of the upper body along the shot direction. */
  readonly impulseScale: number;
  /** force → initial tip-over ANGULAR speed (rad/s) of the chest about the axis ⟂ the shot. */
  readonly torqueScale: number;
  /** Total kinetic proxy Σ(|v|²+|ω|²) below which the body is declared SETTLED (then it stops integrating). */
  readonly settleEnergyThreshold: number;
  /** Loose cone/twist limit (rad): max deviation of a joint's relative orientation from its rest pose. */
  readonly jointConeRadians: number;
  /** Collision radius (m) of every body capsule end-sphere against the ground plane (the body rests this far up). */
  readonly groundRadiusMeters: number;
  /** Capsule radius (m) used for each body's mass + diagonal inertia (its thickness for tumbling). */
  readonly capsuleRadiusMeters: number;
}

/** A point-to-point joint: the parent body's `anchorParent` (body-local) must coincide with the child's `anchorChild`. */
interface JointSpec {
  readonly parent: number;
  readonly child: number;
  /** Anchor point in the PARENT body-local frame. */
  readonly anchorParent: readonly [number, number, number];
  /** Anchor point in the CHILD body-local frame. */
  readonly anchorChild: readonly [number, number, number];
  /** Rest relative orientation q0p⁻¹·q0c (the cone limit measures deviation from this). */
  readonly restRel: readonly [number, number, number, number];
}

/** The immutable per-archetype ragdoll definition (one entry per rigid body + the joints wiring them). */
export interface RagdollSpec {
  readonly bodyCount: number;
  readonly boneCount: number;
  /** Per-body inverse mass (length bodyCount). */
  readonly invMass: Float64Array;
  /** Per-body diagonal inverse inertia in BODY-LOCAL coords (length bodyCount*3). */
  readonly invInertia: Float64Array;
  /** Per-body rest center (length bodyCount*3). */
  readonly restPos: Float64Array;
  /** Per-body rest orientation quat x,y,z,w (length bodyCount*4). */
  readonly restQuat: Float64Array;
  /** Per-body inverse rest matrix, column-major (length bodyCount*16) — for Δ = mat4(c,q)·invRest. */
  readonly invRest: Float64Array;
  /** Per-body capsule end A in body-local coords (length bodyCount*3). */
  readonly capA: Float64Array;
  /** Per-body capsule end B in body-local coords (length bodyCount*3). */
  readonly capB: Float64Array;
  /** Per-body capsule end-sphere ground-collision radius (length bodyCount). */
  readonly radius: Float64Array;
  /** Per-body carried GLB bone indices. */
  readonly bones: readonly (readonly number[])[];
  readonly joints: readonly JointSpec[];
  /** Baked idle skinning matrices, column-major, length boneCount*16. */
  readonly m0: Float32Array;
}

/** One rigid body's raw topology input to `buildRagdollSpec`. */
export interface RagdollBodyTopology {
  /** GLB bone indices this body carries rigidly. */
  readonly bones: readonly number[];
  /** Particle indices (into `seed`) of the capsule's two ends — equal for a sphere-like body (head). */
  readonly capStart: number;
  readonly capEnd: number;
  /** The body's idle world transform (output-local): rigid position + orientation captured in the bake. */
  readonly restPos: readonly [number, number, number];
  readonly restQuat: readonly [number, number, number, number];
}

/** One joint's raw topology input: which two bodies, sharing which joint particle (its seed position). */
export interface RagdollJointTopology {
  readonly parent: number;
  readonly child: number;
  /** Particle index (into `seed`) whose seed position is the shared anchor at rest. */
  readonly particle: number;
}

/** Raw topology input to `buildRagdollSpec`. */
export interface RagdollTopology {
  readonly boneCount: number;
  /** Seed joint-particle positions, output-local meters, length RAGDOLL_PARTICLE_COUNT*3. */
  readonly seed: Float32Array;
  /** Baked idle skinning matrices, column-major, length boneCount*16. */
  readonly m0: Float32Array;
  readonly bodies: readonly RagdollBodyTopology[];
  readonly joints: readonly RagdollJointTopology[];
}

const EPS = 1e-9;
/** Cap any single PBD correction rotation so a low-inertia body can't blow up in one iteration. */
const MAX_CORRECTION_RADIANS = 0.25;
/** Stability guards on the PBD-recomputed velocities (a fast limb whip can spike (Δx/h); keep it physical). */
const MAX_LINEAR_SPEED = 14;
const MAX_ANGULAR_SPEED = 22;

function clampMag(x: number, max: number): number {
  return x > max ? max : x < -max ? -max : x;
}

/**
 * Build the immutable spec: per-body mass/inertia from the capsule dimensions (derived from the seed), the rest
 * transforms (decomposed into c,q + inverse matrix), and the joint anchors (the shared particle expressed in each
 * body's local frame). PURE — same inputs always yield the same spec (V26).
 */
export function buildRagdollSpec(topo: RagdollTopology, cfg: RagdollConfig): RagdollSpec {
  const { seed, bodies, joints } = topo;
  const B = bodies.length;
  const invMass = new Float64Array(B);
  const invInertia = new Float64Array(B * 3);
  const restPos = new Float64Array(B * 3);
  const restQuat = new Float64Array(B * 4);
  const invRest = new Float64Array(B * 16);
  const capA = new Float64Array(B * 3);
  const capB = new Float64Array(B * 3);
  const radius = new Float64Array(B);
  const boneLists: (readonly number[])[] = [];
  const r = cfg.capsuleRadiusMeters;

  for (let i = 0; i < B; i++) {
    const body = bodies[i]!;
    boneLists.push(body.bones.slice());
    radius[i] = cfg.groundRadiusMeters;
    // Rest transform (c0, q0) + inverse matrix.
    restPos[i * 3] = body.restPos[0];
    restPos[i * 3 + 1] = body.restPos[1];
    restPos[i * 3 + 2] = body.restPos[2];
    restQuat[i * 4] = body.restQuat[0];
    restQuat[i * 4 + 1] = body.restQuat[1];
    restQuat[i * 4 + 2] = body.restQuat[2];
    restQuat[i * 4 + 3] = body.restQuat[3];
    normalizeQuatAt(restQuat, i * 4);
    composeMat4(_m0, restPos, i * 3, restQuat, i * 4);
    invertRigidMat4(invRest, i * 16, _m0);

    // Capsule ends in WORLD (seed) space → body-local via inverse rest orientation.
    const sa = body.capStart * 3;
    const sb = body.capEnd * 3;
    worldToLocal(capA, i * 3, restPos, i * 3, restQuat, i * 4, seed[sa]!, seed[sa + 1]!, seed[sa + 2]!);
    worldToLocal(capB, i * 3, restPos, i * 3, restQuat, i * 4, seed[sb]!, seed[sb + 1]!, seed[sb + 2]!);

    // Capsule length + mass + diagonal inertia (cylinder approximation, density 1 — only RELATIVE mass matters).
    const dx = capB[i * 3]! - capA[i * 3]!;
    const dy = capB[i * 3 + 1]! - capA[i * 3 + 1]!;
    const dz = capB[i * 3 + 2]! - capA[i * 3 + 2]!;
    const L = Math.hypot(dx, dy, dz);
    const m = Math.PI * r * r * L + (4 / 3) * Math.PI * r * r * r; // capsule volume, density 1
    invMass[i] = m > EPS ? 1 / m : 0;
    if (L > EPS) {
      // Body-local capsule axis (unit). Diagonal inertia: axial about the axis, perp across it.
      const ax = dx / L;
      const ay = dy / L;
      const az = dz / L;
      const iAxial = 0.5 * m * r * r;
      const iPerp = m * ((1 / 12) * L * L + 0.25 * r * r);
      for (let k = 0; k < 3; k++) {
        const comp = k === 0 ? ax : k === 1 ? ay : az;
        const I = iAxial * comp * comp + iPerp * (1 - comp * comp);
        invInertia[i * 3 + k] = I > EPS ? 1 / I : 0;
      }
    } else {
      // Sphere (head): isotropic inertia.
      const I = (2 / 5) * m * r * r;
      const inv = I > EPS ? 1 / I : 0;
      invInertia[i * 3] = inv;
      invInertia[i * 3 + 1] = inv;
      invInertia[i * 3 + 2] = inv;
    }
  }

  const jointSpecs: JointSpec[] = joints.map((j) => {
    const p = j.parent;
    const c = j.child;
    const s = j.particle * 3;
    const aP = _v1;
    const aC = _v2;
    worldToLocalVec(aP, restPos, p * 3, restQuat, p * 4, seed[s]!, seed[s + 1]!, seed[s + 2]!);
    worldToLocalVec(aC, restPos, c * 3, restQuat, c * 4, seed[s]!, seed[s + 1]!, seed[s + 2]!);
    // restRel = q0p⁻¹ · q0c
    conjQuat(_q0, restQuat, p * 4);
    quatMulInto(_q1, _q0, 0, restQuat, c * 4);
    return {
      parent: p,
      child: c,
      anchorParent: [aP[0]!, aP[1]!, aP[2]!] as const,
      anchorChild: [aC[0]!, aC[1]!, aC[2]!] as const,
      restRel: [_q1[0]!, _q1[1]!, _q1[2]!, _q1[3]!] as const,
    };
  });

  return {
    bodyCount: B,
    boneCount: topo.boneCount,
    invMass,
    invInertia,
    restPos,
    restQuat,
    invRest,
    capA,
    capB,
    radius,
    bones: boneLists,
    joints: jointSpecs,
    m0: topo.m0,
  };
}

/**
 * One corpse's live ragdoll state. Pooled + reset in place (no per-death allocation after warm-up, V24). All
 * scratch buffers are sized to the spec at construction; `reset` re-seeds them for a fresh fall.
 */
export class Ragdoll {
  spec: RagdollSpec;
  /** Per-body center (output-local m), length bodyCount*3. */
  readonly c: Float64Array;
  /** Per-body orientation quat x,y,z,w, length bodyCount*4. */
  readonly q: Float64Array;
  /** Per-body linear velocity, length bodyCount*3. */
  readonly v: Float64Array;
  /** Per-body angular velocity (world), length bodyCount*3. */
  readonly w: Float64Array;
  private readonly cPrev: Float64Array;
  private readonly qPrev: Float64Array;
  /** False until the first step de-penetrates the spawn pose (keeps the pre-step pose exactly M0). */
  private started = false;
  /** Cached emitted bone matrices (column-major, boneCount*16) — refreshed only while moving. */
  readonly bones: Float32Array;
  settled = false;
  /** Liveness generation for the owning pool (set by the caller each frame it is seen). */
  gen = -1;

  constructor(spec: RagdollSpec) {
    this.spec = spec;
    const B = spec.bodyCount;
    this.c = new Float64Array(B * 3);
    this.q = new Float64Array(B * 4);
    this.v = new Float64Array(B * 3);
    this.w = new Float64Array(B * 3);
    this.cPrev = new Float64Array(B * 3);
    this.qPrev = new Float64Array(B * 4);
    this.bones = new Float32Array(spec.boneCount * 16);
  }

  /**
   * (Re)seed this ragdoll for a fresh death. Places every body at the standing idle pose (c,q from bodyRest;
   * v=ω=0), then applies the killing impulse: linear velocity to the UPPER bodies (chest+head, scaled by height)
   * along the LOCAL shot direction + a tip-over angular kick on the chest about the axis ⟂ the shot, so the body
   * pitches over in the shot direction (bigger force → more knockback + faster tip). A force-less death crumples
   * gently forward (local +Z) under gravity. Small seeded per-body v/ω jitter so no two falls match. PURE w.r.t.
   * `rand` (mulberry32) — NEVER Math.random.
   */
  reset(
    spec: RagdollSpec,
    cfg: RagdollConfig,
    impactLocalX: number,
    impactLocalZ: number,
    force: number,
    rand: () => number,
  ): void {
    this.spec = spec;
    this.settled = false;
    this.started = false;
    const B = spec.bodyCount;
    // Seed every body at its rest transform; zero velocities.
    this.c.set(spec.restPos);
    this.q.set(spec.restQuat);
    this.v.fill(0);
    this.w.fill(0);
    this.bones.set(spec.m0); // rest pose until first step

    // Body height (max rest center y) drives the height-scaled upper-body launch.
    let height = 0;
    for (let i = 0; i < B; i++) height = Math.max(height, spec.restPos[i * 3 + 1]!);
    const invH = height > EPS ? 1 / height : 0;

    // Launch direction: the shot's local horizontal push; a force-less death falls forward (local +Z).
    let dx = impactLocalX;
    let dz = impactLocalZ;
    const dmag = Math.hypot(dx, dz);
    if (force > 0 && dmag > EPS) {
      dx /= dmag;
      dz /= dmag;
    } else {
      dx = 0;
      dz = 1;
    }
    // Per-corpse jitter (deterministic): rotate the push a few degrees + vary the magnitude so no two falls match.
    const jitterAng = (rand() - 0.5) * 0.5; // ±~14°
    const ca = Math.cos(jitterAng);
    const sa = Math.sin(jitterAng);
    const jx = ca * dx - sa * dz;
    const jz = sa * dx + ca * dz;
    dx = jx;
    dz = jz;
    const magJitter = 0.85 + rand() * 0.3; // ±15%
    const linSpeed = (force > 0 ? cfg.impulseScale * force : cfg.impulseScale * 1.2) * magJitter;
    const spin = (force > 0 ? cfg.torqueScale * force : cfg.torqueScale * 1.2) * magJitter;
    // Tip axis = up × pushDir (rotating the body's top toward the push direction).
    const tipX = dz; // (0,1,0) × (dx,0,dz) = (dz, 0, -dx)
    const tipZ = -dx;

    // Upper bodies (chest=1, head=2 by RAGDOLL_BODIES order) carry the knockback + tip; everything else just gets
    // a whisper of seeded jitter so the limbs flop uniquely under gravity + the joint drag.
    const v = this.v;
    const w = this.w;
    for (let i = 0; i < B; i++) {
      const b3 = i * 3;
      const hFrac = invH > 0 ? spec.restPos[b3 + 1]! * invH : 1;
      let vx = 0, vy = 0, vz = 0, wx = 0, wy = 0, wz = 0;
      if (i === RAGDOLL_BODY_INDEX.chest || i === RAGDOLL_BODY_INDEX.head) {
        const s = linSpeed * (0.5 + 0.5 * hFrac);
        vx += dx * s;
        vz += dz * s;
      }
      if (i === RAGDOLL_BODY_INDEX.chest) {
        wx += tipX * spin;
        wz += tipZ * spin;
      }
      // Seeded per-body jitter (small) so the fall is unique yet reproducible.
      vx += (rand() - 0.5) * 0.25 * linSpeed;
      vy += (rand() - 0.5) * 0.15 * linSpeed;
      vz += (rand() - 0.5) * 0.25 * linSpeed;
      wx += (rand() - 0.5) * 0.4 * spin;
      wy += (rand() - 0.5) * 0.4 * spin;
      wz += (rand() - 0.5) * 0.4 * spin;
      v[b3] = vx; v[b3 + 1] = vy; v[b3 + 2] = vz;
      w[b3] = wx; w[b3 + 1] = wy; w[b3 + 2] = wz;
    }
  }

  /**
   * De-penetrate the spawn pose: the idle feet sit a touch below the capsule radius, and a PBD ground push-out of
   * that initial overlap (resolved over one tiny substep) would inject a huge phantom velocity → the body rockets
   * off. Lift the whole body so its lowest capsule sample rests exactly on its radius. Done LAZILY on the first
   * step (not in reset) so the pre-step rest pose stays EXACTLY M0 (Δ=I) — a corpse drawn before its first step
   * still reads as the clean standing idle. No velocity is injected (it is a teleport before the substep baseline).
   */
  private depenetrate(): void {
    const spec = this.spec;
    let lowest = Infinity;
    for (let i = 0; i < spec.bodyCount; i++) {
      const n = capsuleSampleCount(spec, i);
      for (let k = 0; k < n; k++) {
        capsuleSamplePoint(spec, i, k, this.q, this.c, _pt);
        lowest = Math.min(lowest, _pt[1]! - spec.radius[i]!);
      }
    }
    if (lowest < 0) {
      const lift = -lowest + 1e-4;
      for (let i = 0; i < spec.bodyCount; i++) this.c[i * 3 + 1] = this.c[i * 3 + 1]! + lift;
    }
  }

  /**
   * Advance the sim by `dt` seconds (split into `cfg.substeps` substeps). Sets `settled` once the total kinetic
   * proxy decays below the threshold; a settled ragdoll should not be stepped again (the caller stops). NaN-safe.
   */
  step(cfg: RagdollConfig, dt: number): void {
    if (this.settled || !(dt > 0)) return;
    if (!this.started) {
      this.depenetrate();
      this.started = true;
    }
    const sub = Math.max(1, cfg.substeps | 0);
    const h = dt / sub;
    let energy = 0;
    for (let s = 0; s < sub; s++) energy = this.substep(cfg, h);
    if (energy < cfg.settleEnergyThreshold) this.settled = true;
  }

  /** One substep: integrate v,ω → integrate c,q → joints + cones → ground push → recompute v,ω → contacts. */
  private substep(cfg: RagdollConfig, h: number): number {
    const spec = this.spec;
    const B = spec.bodyCount;
    const im = spec.invMass;
    const c = this.c;
    const q = this.q;
    const v = this.v;
    const w = this.w;
    const g = cfg.gravity;
    const linDamp = clamp01(1 - cfg.linearDamping * h);
    const angDamp = clamp01(1 - cfg.angularDamping * h);

    // --- Integrate velocities (gravity + damping), then positions. ---
    this.cPrev.set(c);
    this.qPrev.set(q);
    for (let i = 0; i < B; i++) {
      if (im[i]! <= 0) continue;
      const b3 = i * 3;
      v[b3] = v[b3]! * linDamp;
      v[b3 + 1] = (v[b3 + 1]! - g * h) * linDamp;
      v[b3 + 2] = v[b3 + 2]! * linDamp;
      w[b3] = w[b3]! * angDamp;
      w[b3 + 1] = w[b3 + 1]! * angDamp;
      w[b3 + 2] = w[b3 + 2]! * angDamp;
      c[b3] = c[b3]! + v[b3]! * h;
      c[b3 + 1] = c[b3 + 1]! + v[b3 + 1]! * h;
      c[b3 + 2] = c[b3 + 2]! + v[b3 + 2]! * h;
      integrateQuat(q, i * 4, w, b3, h);
    }

    // --- JOINT (point-to-point + cone) positional solve only (PBD, iterated). The ground is handled separately
    // (velocity impulse + a Baumgarte push that does NOT feed back into velocity) so the ground push-out can't pump
    // energy into the recompute → re-penetrate loop that made the body vibrate at the velocity clamp. ---
    const iters = Math.max(1, cfg.constraintIterations | 0);
    for (let it = 0; it < iters; it++) {
      for (let jx = 0; jx < spec.joints.length; jx++) this.solveJoint(spec.joints[jx]!);
    }

    // --- Recompute velocities from the JOINT position delta (this is what swings the limbs). ---
    for (let i = 0; i < B; i++) {
      if (im[i]! <= 0) continue;
      const b3 = i * 3;
      v[b3] = clampMag((c[b3]! - this.cPrev[b3]!) / h, MAX_LINEAR_SPEED);
      v[b3 + 1] = clampMag((c[b3 + 1]! - this.cPrev[b3 + 1]!) / h, MAX_LINEAR_SPEED);
      v[b3 + 2] = clampMag((c[b3 + 2]! - this.cPrev[b3 + 2]!) / h, MAX_LINEAR_SPEED);
      angVelFromQuats(w, b3, this.qPrev, i * 4, q, i * 4, h);
      w[b3] = clampMag(w[b3]!, MAX_ANGULAR_SPEED);
      w[b3 + 1] = clampMag(w[b3 + 1]!, MAX_ANGULAR_SPEED);
      w[b3 + 2] = clampMag(w[b3 + 2]!, MAX_ANGULAR_SPEED);
    }
    // --- Ground at VELOCITY level (restitution + friction at the contact point → tumbles + settles), THEN a
    // positional Baumgarte push-out (AFTER the recompute, so the lift injects NO velocity → no vibration pump). ---
    this.solveContacts(cfg);
    this.solveConeLimits(cfg.jointConeRadians);
    this.solveGround();

    // --- Kinetic proxy: Σ(|v|²+|ω|²). ---
    let energy = 0;
    for (let i = 0; i < B; i++) {
      if (im[i]! <= 0) continue;
      energy += v[i * 3]! ** 2 + v[i * 3 + 1]! ** 2 + v[i * 3 + 2]! ** 2;
      energy += w[i * 3]! ** 2 + w[i * 3 + 1]! ** 2 + w[i * 3 + 2]! ** 2;
    }
    return energy;
  }

  /** PBD point-to-point joint. Corrects both bodies' c (translation) and q (orientation) so the shared anchor
   *  coincides — the angular part (the lever-arm correction) is what swings the limbs. The cone/twist limit is a
   *  SEPARATE velocity-level pass (`solveConeLimits`) so it can only remove energy, never pump it. */
  private solveJoint(j: JointSpec): void {
    const spec = this.spec;
    const p = j.parent;
    const cb = j.child;
    const c = this.c;
    const q = this.q;
    // World anchors via each body's lever arm.
    rotateVec(_rp, q, p * 4, j.anchorParent[0], j.anchorParent[1], j.anchorParent[2]);
    rotateVec(_rc, q, cb * 4, j.anchorChild[0], j.anchorChild[1], j.anchorChild[2]);
    const apx = c[p * 3]! + _rp[0]!;
    const apy = c[p * 3 + 1]! + _rp[1]!;
    const apz = c[p * 3 + 2]! + _rp[2]!;
    const acx = c[cb * 3]! + _rc[0]!;
    const acy = c[cb * 3 + 1]! + _rc[1]!;
    const acz = c[cb * 3 + 2]! + _rc[2]!;
    // C = anchorChild - anchorParent (drive to zero). n = unit(C).
    let Cx = acx - apx;
    let Cy = acy - apy;
    let Cz = acz - apz;
    const Cmag = Math.hypot(Cx, Cy, Cz);
    if (Cmag > EPS) {
      const nx = Cx / Cmag;
      const ny = Cy / Cmag;
      const nz = Cz / Cmag;
      // Effective inverse mass for each body along n at its lever arm.
      const wp = effectiveInvMass(spec, p, q, _rp, nx, ny, nz, _ip);
      const wc = effectiveInvMass(spec, cb, q, _rc, nx, ny, nz, _ic);
      const total = wp + wc;
      if (total > EPS) {
        const lambda = Cmag / total;
        // Parent moves +, child moves − (so anchors meet).
        applyPositional(this, p, +lambda, nx, ny, nz, _ip);
        applyPositional(this, cb, -lambda, nx, ny, nz, _ic);
      }
    }
  }

  /**
   * Loose cone/twist limit as a VELOCITY pass (run after the velocity recompute + contacts, so it can only REMOVE
   * energy — a positional cone fights the joint point constraint and pumps energy → the body vibrates). For each
   * joint whose relative orientation has deviated past `coneAngle` from rest, remove the component of the relative
   * angular velocity that is OPENING the deviation further (a one-sided limit): the joint can swing back freely but
   * cannot keep hyperextending through. Split by inverse inertia about the deviation axis (momentum-respecting).
   */
  private solveConeLimits(coneAngle: number): void {
    const spec = this.spec;
    const q = this.q;
    const w = this.w;
    for (let jx = 0; jx < spec.joints.length; jx++) {
      const j = spec.joints[jx]!;
      const p = j.parent;
      const cb = j.child;
      conjQuat(_q0, q, p * 4);
      quatMulInto(_q1, _q0, 0, q, cb * 4); // qRel = qp⁻¹·qc
      conjQuatArr(_q2, j.restRel as unknown as ArrayLike<number>, 0);
      quatMulInto(_q3, _q2, 0, _q1, 0); // err = restRel⁻¹·qRel
      let ew = _q3[3]!, ex = _q3[0]!, ey = _q3[1]!, ez = _q3[2]!;
      if (ew < 0) { ew = -ew; ex = -ex; ey = -ey; ez = -ez; }
      const angle = 2 * Math.acos(ew < 1 ? ew : 1);
      if (angle <= coneAngle) continue;
      const s = Math.sqrt(Math.max(0, 1 - ew * ew));
      if (s <= EPS) continue;
      rotateVec(_v1, q, p * 4, ex / s, ey / s, ez / s); // deviation axis (parent-local) → world unit
      const ax = _v1[0]!, ay = _v1[1]!, az = _v1[2]!;
      // Relative angular velocity ω_c − ω_p projected onto the deviation axis. >0 ⇒ opening further.
      const rel = (w[cb * 3]! - w[p * 3]!) * ax + (w[cb * 3 + 1]! - w[p * 3 + 1]!) * ay + (w[cb * 3 + 2]! - w[p * 3 + 2]!) * az;
      if (rel <= 0) continue; // already closing / static — leave it floppy
      const ip = inertiaAboutAxis(spec, p, q, ax, ay, az);
      const ic = inertiaAboutAxis(spec, cb, q, ax, ay, az);
      const tot = ip + ic;
      if (tot <= EPS) continue;
      // Remove the opening relative angular velocity: child −, parent + (about the axis), split by inverse inertia.
      const dC = -rel * (ic / tot);
      const dP = +rel * (ip / tot);
      w[cb * 3] = w[cb * 3]! + ax * dC;
      w[cb * 3 + 1] = w[cb * 3 + 1]! + ay * dC;
      w[cb * 3 + 2] = w[cb * 3 + 2]! + az * dC;
      w[p * 3] = w[p * 3]! + ax * dP;
      w[p * 3 + 1] = w[p * 3 + 1]! + ay * dP;
      w[p * 3 + 2] = w[p * 3 + 2]! + az * dP;
    }
  }

  /** Positional ground push-out: for each capsule sample point below the radius, lift it back to the plane. */
  private solveGround(): void {
    const spec = this.spec;
    const B = spec.bodyCount;
    for (let i = 0; i < B; i++) {
      if (spec.invMass[i]! <= 0) continue;
      const rad = spec.radius[i]!;
      const n = capsuleSampleCount(spec, i);
      for (let k = 0; k < n; k++) {
        capsuleSamplePoint(spec, i, k, this.q, this.c, _pt);
        const py = _pt[1]!;
        if (py < rad) {
          const d = rad - py;
          const rx = _pt[0]! - this.c[i * 3]!;
          const ry = py - this.c[i * 3 + 1]!;
          const rz = _pt[2]! - this.c[i * 3 + 2]!;
          _rp[0] = rx; _rp[1] = ry; _rp[2] = rz;
          const wEff = effectiveInvMass(spec, i, this.q, _rp, 0, 1, 0, _ip);
          if (wEff > EPS) {
            const lambda = d / wEff;
            applyPositional(this, i, +lambda, 0, 1, 0, _ip);
          }
        }
      }
    }
  }

  /** Contact velocity impulses: at each penetrating sample point, apply normal restitution + Coulomb friction. */
  private solveContacts(cfg: RagdollConfig): void {
    const spec = this.spec;
    const B = spec.bodyCount;
    const rest = cfg.groundRestitution;
    const fric = cfg.groundFriction;
    for (let i = 0; i < B; i++) {
      if (spec.invMass[i]! <= 0) continue;
      const rad = spec.radius[i]!;
      const n = capsuleSampleCount(spec, i);
      for (let k = 0; k < n; k++) {
        capsuleSamplePoint(spec, i, k, this.q, this.c, _pt);
        if (_pt[1]! > rad + 1e-4) continue;
        const rx = _pt[0]! - this.c[i * 3]!;
        const ry = _pt[1]! - this.c[i * 3 + 1]!;
        const rz = _pt[2]! - this.c[i * 3 + 2]!;
        // Contact-point velocity vp = v + ω × r.
        const vpx = this.v[i * 3]! + (this.w[i * 3 + 1]! * rz - this.w[i * 3 + 2]! * ry);
        const vpy = this.v[i * 3 + 1]! + (this.w[i * 3 + 2]! * rx - this.w[i * 3]! * rz);
        const vpz = this.v[i * 3 + 2]! + (this.w[i * 3]! * ry - this.w[i * 3 + 1]! * rx);
        const vn = vpy; // n = (0,1,0)
        if (vn >= 0) continue; // separating
        _rp[0] = rx; _rp[1] = ry; _rp[2] = rz;
        const wN = effectiveInvMass(spec, i, this.q, _rp, 0, 1, 0, _ip);
        if (wN <= EPS) continue;
        const jn = (-(1 + rest) * vn) / wN;
        applyImpulse(this, i, 0, jn, 0, _rp);
        // Friction along the tangential velocity, clamped to μ·jn.
        const vtx = vpx;
        const vtz = vpz;
        const vtLen = Math.hypot(vtx, vtz);
        if (vtLen > EPS) {
          const tx = vtx / vtLen;
          const tz = vtz / vtLen;
          _rp[0] = rx; _rp[1] = ry; _rp[2] = rz;
          const wT = effectiveInvMass(spec, i, this.q, _rp, tx, 0, tz, _ip);
          if (wT > EPS) {
            let jt = vtLen / wT;
            const jtMax = fric * jn;
            if (jt > jtMax) jt = jtMax;
            applyImpulse(this, i, -jt * tx, 0, -jt * tz, _rp);
          }
        }
      }
    }
  }

  /**
   * Recompute the cached live bone matrices from the current body transforms (Δ = mat4(c,q)·invRest; per carried
   * bone M_b = Δ·M0_b, column-major) into `out` at `outOffset` (length boneCount*16). Skips the recompute when
   * settled (the cached frozen matrices are reused).
   */
  writeBones(out: Float32Array, outOffset: number): void {
    if (!this.settled) this.recomputeBones();
    out.set(this.bones, outOffset);
  }

  /** Fill `this.bones` from the current body transforms. NaN-safe. */
  private recomputeBones(): void {
    const spec = this.spec;
    const out = this.bones;
    for (let i = 0; i < spec.bodyCount; i++) {
      composeMat4(_mA, this.c, i * 3, this.q, i * 4); // mat4(c,q)
      mulMat4(_mB, _mA, spec.invRest, i * 16); // Δ = mat4(c,q)·invRest
      const list = spec.bones[i]!;
      for (let b = 0; b < list.length; b++) {
        const bi = list[b]!;
        mulMat4ByM0(out, bi * 16, _mB, spec.m0, bi * 16);
      }
    }
  }
}

// ---- Scratch (module-level, reused — no per-frame allocation in the hot loop, V24) ----
const _v0 = new Float64Array(3);
const _v1 = new Float64Array(3);
const _v2 = new Float64Array(3);
const _rp = new Float64Array(3);
const _rc = new Float64Array(3);
const _ip = new Float64Array(3); // invI·(r×n) for parent / single body
const _ic = new Float64Array(3); // invI·(r×n) for child
const _pt = new Float64Array(3);
const _q0 = new Float64Array(4);
const _q1 = new Float64Array(4);
const _q2 = new Float64Array(4);
const _q3 = new Float64Array(4);
const _m0 = new Float64Array(16);
const _mA = new Float64Array(16);
const _mB = new Float64Array(16);

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Effective inverse mass of body `i` for a unit direction (nx,ny,nz) applied at lever arm `r`. Fills `outIp`
 *  with invI·(r×n) (world) for reuse by the corresponding apply. */
function effectiveInvMass(
  spec: RagdollSpec,
  i: number,
  q: Float64Array,
  r: Float64Array,
  nx: number,
  ny: number,
  nz: number,
  outIp: Float64Array,
): number {
  // a = r × n
  const ax = r[1]! * nz - r[2]! * ny;
  const ay = r[2]! * nx - r[0]! * nz;
  const az = r[0]! * ny - r[1]! * nx;
  applyInvInertiaWorld(outIp, q, i * 4, spec.invInertia, i * 3, ax, ay, az);
  const angular = ax * outIp[0]! + ay * outIp[1]! + az * outIp[2]!;
  return spec.invMass[i]! + angular;
}

/** Inverse inertia of body `i` about world unit axis (ax,ay,az): aᵀ·I⁻¹·a (used for the cone-limit momentum split). */
function inertiaAboutAxis(spec: RagdollSpec, i: number, q: Float64Array, ax: number, ay: number, az: number): number {
  applyInvInertiaWorld(_axI, q, i * 4, spec.invInertia, i * 3, ax, ay, az);
  return ax * _axI[0]! + ay * _axI[1]! + az * _axI[2]!;
}
const _axI = new Float64Array(3);

/** Apply a PBD positional correction of `lambda` along n to body `i` (translation + rotation by the lever arm). */
function applyPositional(
  rag: Ragdoll,
  i: number,
  lambda: number,
  nx: number,
  ny: number,
  nz: number,
  ip: Float64Array,
): void {
  const spec = rag.spec;
  const im = spec.invMass[i]!;
  const b3 = i * 3;
  rag.c[b3] = rag.c[b3]! + im * lambda * nx;
  rag.c[b3 + 1] = rag.c[b3 + 1]! + im * lambda * ny;
  rag.c[b3 + 2] = rag.c[b3 + 2]! + im * lambda * nz;
  // dθ = invI·(r × (lambda n)) = lambda · ip (ip already = invI·(r×n)).
  applyAxisDelta(rag.q, i * 4, ip[0]! * lambda, ip[1]! * lambda, ip[2]! * lambda);
}

/** Apply a linear+angular IMPULSE (Jx,Jy,Jz) at lever arm `r` to body `i` (changes v and ω). */
function applyImpulse(rag: Ragdoll, i: number, jx: number, jy: number, jz: number, r: Float64Array): void {
  const spec = rag.spec;
  const im = spec.invMass[i]!;
  const b3 = i * 3;
  rag.v[b3] = rag.v[b3]! + im * jx;
  rag.v[b3 + 1] = rag.v[b3 + 1]! + im * jy;
  rag.v[b3 + 2] = rag.v[b3 + 2]! + im * jz;
  // Δω = invI·(r × J)
  const tx = r[1]! * jz - r[2]! * jy;
  const ty = r[2]! * jx - r[0]! * jz;
  const tz = r[0]! * jy - r[1]! * jx;
  applyInvInertiaWorld(_v0, rag.q, i * 4, spec.invInertia, i * 3, tx, ty, tz);
  rag.w[b3] = rag.w[b3]! + _v0[0]!;
  rag.w[b3 + 1] = rag.w[b3 + 1]! + _v0[1]!;
  rag.w[b3 + 2] = rag.w[b3 + 2]! + _v0[2]!;
}

/** Apply invI (diagonal body-local) to a world vector a → world: out = R·(invIlocal ⊙ (Rᵀ·a)). */
function applyInvInertiaWorld(
  out: Float64Array,
  q: Float64Array,
  qOff: number,
  invI: Float64Array,
  iOff: number,
  ax: number,
  ay: number,
  az: number,
): void {
  rotateVecConj(_lv, q, qOff, ax, ay, az); // local = Rᵀ·a
  const lx = _lv[0]! * invI[iOff]!;
  const ly = _lv[1]! * invI[iOff + 1]!;
  const lz = _lv[2]! * invI[iOff + 2]!;
  rotateVec(out, q, qOff, lx, ly, lz); // world = R·local
}
const _lv = new Float64Array(3);

/** Rotate a rigid quaternion at `q[off]` by the small world rotation vector (dx,dy,dz) (capped to avoid blowup). */
function applyAxisDelta(q: Float64Array, off: number, dx: number, dy: number, dz: number): void {
  let mag = Math.hypot(dx, dy, dz);
  if (mag < EPS) return;
  if (mag > MAX_CORRECTION_RADIANS) {
    const s = MAX_CORRECTION_RADIANS / mag;
    dx *= s; dy *= s; dz *= s; mag = MAX_CORRECTION_RADIANS;
  }
  // q' = normalize(q + 0.5·(dx,dy,dz,0)⊗q)
  const qx = q[off]!;
  const qy = q[off + 1]!;
  const qz = q[off + 2]!;
  const qw = q[off + 3]!;
  const ow = -dx * qx - dy * qy - dz * qz;
  const ox = dx * qw + dy * qz - dz * qy;
  const oy = -dx * qz + dy * qw + dz * qx;
  const oz = dx * qy - dy * qx + dz * qw;
  let nx = qx + 0.5 * ox;
  let ny = qy + 0.5 * oy;
  let nz = qz + 0.5 * oz;
  let nw = qw + 0.5 * ow;
  const inv = 1 / (Math.hypot(nx, ny, nz, nw) || 1);
  q[off] = nx * inv;
  q[off + 1] = ny * inv;
  q[off + 2] = nz * inv;
  q[off + 3] = nw * inv;
}

/** Number of ground-collision sample points on body `i`'s capsule (1 = sphere, 3 = the two ends + midpoint). */
function capsuleSampleCount(spec: RagdollSpec, i: number): number {
  const ax = spec.capA[i * 3]!;
  const ay = spec.capA[i * 3 + 1]!;
  const az = spec.capA[i * 3 + 2]!;
  const bx = spec.capB[i * 3]!;
  const by = spec.capB[i * 3 + 1]!;
  const bz = spec.capB[i * 3 + 2]!;
  return Math.hypot(bx - ax, by - ay, bz - az) > EPS ? 3 : 1;
}

/** World position of capsule sample `k` (0=A, 1=B, 2=mid) on body `i`. */
function capsuleSamplePoint(spec: RagdollSpec, i: number, k: number, q: Float64Array, c: Float64Array, out: Float64Array): void {
  let lx: number, ly: number, lz: number;
  if (k === 0) {
    lx = spec.capA[i * 3]!; ly = spec.capA[i * 3 + 1]!; lz = spec.capA[i * 3 + 2]!;
  } else if (k === 1) {
    lx = spec.capB[i * 3]!; ly = spec.capB[i * 3 + 1]!; lz = spec.capB[i * 3 + 2]!;
  } else {
    lx = 0.5 * (spec.capA[i * 3]! + spec.capB[i * 3]!);
    ly = 0.5 * (spec.capA[i * 3 + 1]! + spec.capB[i * 3 + 1]!);
    lz = 0.5 * (spec.capA[i * 3 + 2]! + spec.capB[i * 3 + 2]!);
  }
  rotateVec(out, q, i * 4, lx, ly, lz);
  out[0] = out[0]! + c[i * 3]!;
  out[1] = out[1]! + c[i * 3 + 1]!;
  out[2] = out[2]! + c[i * 3 + 2]!;
}

// ---- Quaternion / matrix helpers (Float64, deterministic) ----

function normalizeQuatAt(q: Float64Array, off: number): void {
  const m = Math.hypot(q[off]!, q[off + 1]!, q[off + 2]!, q[off + 3]!);
  if (m < EPS) { q[off] = 0; q[off + 1] = 0; q[off + 2] = 0; q[off + 3] = 1; return; }
  const inv = 1 / m;
  q[off] = q[off]! * inv; q[off + 1] = q[off + 1]! * inv; q[off + 2] = q[off + 2]! * inv; q[off + 3] = q[off + 3]! * inv;
}

function conjQuat(out: Float64Array, q: Float64Array, off: number): void {
  out[0] = -q[off]!; out[1] = -q[off + 1]!; out[2] = -q[off + 2]!; out[3] = q[off + 3]!;
}

function conjQuatArr(out: Float64Array, q: ArrayLike<number>, off: number): void {
  out[0] = -q[off]!; out[1] = -q[off + 1]!; out[2] = -q[off + 2]!; out[3] = q[off + 3]!;
}

/** out = a ⊗ b (Hamilton), a at a[0..], b at b[bOff..]. */
function quatMulInto(out: Float64Array, a: ArrayLike<number>, aOff: number, b: ArrayLike<number>, bOff: number): void {
  const ax = a[aOff]!, ay = a[aOff + 1]!, az = a[aOff + 2]!, aw = a[aOff + 3]!;
  const bx = b[bOff]!, by = b[bOff + 1]!, bz = b[bOff + 2]!, bw = b[bOff + 3]!;
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** out = R(q) · (vx,vy,vz). */
function rotateVec(out: Float64Array, q: Float64Array, off: number, vx: number, vy: number, vz: number): void {
  const x = q[off]!, y = q[off + 1]!, z = q[off + 2]!, w = q[off + 3]!;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
}

/** out = R(q)ᵀ · (vx,vy,vz) (rotate by the conjugate). */
function rotateVecConj(out: Float64Array, q: Float64Array, off: number, vx: number, vy: number, vz: number): void {
  const x = -q[off]!, y = -q[off + 1]!, z = -q[off + 2]!, w = q[off + 3]!;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
}

/** Integrate quaternion q[off] by world angular velocity w[wOff] over h: q += 0.5·h·(ω,0)⊗q; normalize. */
function integrateQuat(q: Float64Array, off: number, w: Float64Array, wOff: number, h: number): void {
  const wx = w[wOff]! * h;
  const wy = w[wOff + 1]! * h;
  const wz = w[wOff + 2]! * h;
  applyAxisDeltaUncapped(q, off, wx, wy, wz);
}

/** Like applyAxisDelta but without the correction cap (used for true integration of ω·h). */
function applyAxisDeltaUncapped(q: Float64Array, off: number, dx: number, dy: number, dz: number): void {
  const qx = q[off]!, qy = q[off + 1]!, qz = q[off + 2]!, qw = q[off + 3]!;
  const ow = -dx * qx - dy * qy - dz * qz;
  const ox = dx * qw + dy * qz - dz * qy;
  const oy = -dx * qz + dy * qw + dz * qx;
  const oz = dx * qy - dy * qx + dz * qw;
  let nx = qx + 0.5 * ox;
  let ny = qy + 0.5 * oy;
  let nz = qz + 0.5 * oz;
  let nw = qw + 0.5 * ow;
  const inv = 1 / (Math.hypot(nx, ny, nz, nw) || 1);
  q[off] = nx * inv; q[off + 1] = ny * inv; q[off + 2] = nz * inv; q[off + 3] = nw * inv;
}

/** Extract world angular velocity from qPrev→qCur over h: ω = (2/h)·vec(qCur ⊗ qPrev⁻¹) (shortest). */
function angVelFromQuats(out: Float64Array, oOff: number, qPrev: Float64Array, pOff: number, qCur: Float64Array, cOff: number, h: number): void {
  conjQuat(_qp, qPrev, pOff);
  quatMulInto(_qd, qCur, cOff, _qp, 0);
  let dx = _qd[0]!, dy = _qd[1]!, dz = _qd[2]!, dw = _qd[3]!;
  if (dw < 0) { dx = -dx; dy = -dy; dz = -dz; }
  const s = 2 / h;
  out[oOff] = dx * s;
  out[oOff + 1] = dy * s;
  out[oOff + 2] = dz * s;
}
const _qp = new Float64Array(4);
const _qd = new Float64Array(4);

/** World point → body-local: out = R(q)ᵀ·(world - c). */
function worldToLocal(out: Float64Array, oOff: number, c: Float64Array, cOff: number, q: Float64Array, qOff: number, wx: number, wy: number, wz: number): void {
  rotateVecConj(_wl, q, qOff, wx - c[cOff]!, wy - c[cOff + 1]!, wz - c[cOff + 2]!);
  out[oOff] = _wl[0]!; out[oOff + 1] = _wl[1]!; out[oOff + 2] = _wl[2]!;
}
function worldToLocalVec(out: Float64Array, c: Float64Array, cOff: number, q: Float64Array, qOff: number, wx: number, wy: number, wz: number): void {
  rotateVecConj(out, q, qOff, wx - c[cOff]!, wy - c[cOff + 1]!, wz - c[cOff + 2]!);
}
const _wl = new Float64Array(3);

/** Column-major 4x4 from rigid (pos at p[pOff], quat at q[qOff]). */
function composeMat4(out: Float64Array, p: Float64Array, pOff: number, q: Float64Array, qOff: number): void {
  const x = q[qOff]!, y = q[qOff + 1]!, z = q[qOff + 2]!, w = q[qOff + 3]!;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy + wz; out[2] = xz - wy; out[3] = 0;
  out[4] = xy - wz; out[5] = 1 - (xx + zz); out[6] = yz + wx; out[7] = 0;
  out[8] = xz + wy; out[9] = yz - wx; out[10] = 1 - (xx + yy); out[11] = 0;
  out[12] = p[pOff]!; out[13] = p[pOff + 1]!; out[14] = p[pOff + 2]!; out[15] = 1;
}

/** Inverse of a rigid (rotation+translation) column-major 4x4: Rᵀ and -Rᵀ·t. */
function invertRigidMat4(out: Float64Array, oOff: number, m: Float64Array): void {
  // m columns 0..2 are the rotation basis; transpose into out.
  out[oOff] = m[0]!; out[oOff + 1] = m[4]!; out[oOff + 2] = m[8]!; out[oOff + 3] = 0;
  out[oOff + 4] = m[1]!; out[oOff + 5] = m[5]!; out[oOff + 6] = m[9]!; out[oOff + 7] = 0;
  out[oOff + 8] = m[2]!; out[oOff + 9] = m[6]!; out[oOff + 10] = m[10]!; out[oOff + 11] = 0;
  const tx = m[12]!, ty = m[13]!, tz = m[14]!;
  out[oOff + 12] = -(out[oOff]! * tx + out[oOff + 4]! * ty + out[oOff + 8]! * tz);
  out[oOff + 13] = -(out[oOff + 1]! * tx + out[oOff + 5]! * ty + out[oOff + 9]! * tz);
  out[oOff + 14] = -(out[oOff + 2]! * tx + out[oOff + 6]! * ty + out[oOff + 10]! * tz);
  out[oOff + 15] = 1;
}

/** out = A · B[bOff..+16] (all column-major 4x4). */
function mulMat4(out: Float64Array, A: Float64Array, B: Float64Array, bOff: number): void {
  for (let col = 0; col < 4; col++) {
    const b0 = B[bOff + col * 4]!;
    const b1 = B[bOff + col * 4 + 1]!;
    const b2 = B[bOff + col * 4 + 2]!;
    const b3 = B[bOff + col * 4 + 3]!;
    out[col * 4] = A[0]! * b0 + A[4]! * b1 + A[8]! * b2 + A[12]! * b3;
    out[col * 4 + 1] = A[1]! * b0 + A[5]! * b1 + A[9]! * b2 + A[13]! * b3;
    out[col * 4 + 2] = A[2]! * b0 + A[6]! * b1 + A[10]! * b2 + A[14]! * b3;
    out[col * 4 + 3] = A[3]! * b0 + A[7]! * b1 + A[11]! * b2 + A[15]! * b3;
  }
}

/** out[outOff..+16] = A(Float64) · M0[bOff..+16] (column-major). */
function mulMat4ByM0(out: Float32Array, outOff: number, A: Float64Array, M0: Float32Array, bOff: number): void {
  for (let col = 0; col < 4; col++) {
    const b0 = M0[bOff + col * 4]!;
    const b1 = M0[bOff + col * 4 + 1]!;
    const b2 = M0[bOff + col * 4 + 2]!;
    const b3 = M0[bOff + col * 4 + 3]!;
    out[outOff + col * 4] = A[0]! * b0 + A[4]! * b1 + A[8]! * b2 + A[12]! * b3;
    out[outOff + col * 4 + 1] = A[1]! * b0 + A[5]! * b1 + A[9]! * b2 + A[13]! * b3;
    out[outOff + col * 4 + 2] = A[2]! * b0 + A[6]! * b1 + A[10]! * b2 + A[14]! * b3;
    out[outOff + col * 4 + 3] = A[3]! * b0 + A[7]! * b1 + A[11]! * b2 + A[15]! * b3;
  }
}

// ---- HUMANOID TOPOLOGY (GLB-agnostic): 15 joint particles, 11 rigid bodies, 10 joints. The body bone groups
// name the Mixamo bones (identical across all three zombie GLBs); `rigged.ts` resolves names → skeleton indices.
// Pure data — no three / no GPU — so it is unit-testable with a synthetic seed pose. ----

/** Joint particle indices (output-local) — seed positions locate the capsule ends + the joint anchors. */
export const RP = {
  pelvis: 0,
  chest: 1,
  head: 2,
  shoulderL: 3, elbowL: 4, handL: 5,
  shoulderR: 6, elbowR: 7, handR: 8,
  hipL: 9, kneeL: 10, footL: 11,
  hipR: 12, kneeR: 13, footR: 14,
} as const;

export const RAGDOLL_PARTICLE_COUNT = 15;

/** The Mixamo bone that locates each particle (its world position seeds the particle). */
export const RAGDOLL_PARTICLE_BONES: readonly string[] = [
  'Hips', 'Spine02', 'Head',
  'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot',
  'RightUpLeg', 'RightLeg', 'RightFoot',
];

/** Body order — indices referenced by the joints + the seed impulse (chest/head are the "upper" launch bodies). */
export const RAGDOLL_BODY_INDEX = {
  pelvis: 0, chest: 1, head: 2,
  upperArmL: 3, lowerArmL: 4, upperArmR: 5, lowerArmR: 6,
  thighL: 7, shinL: 8, thighR: 9, shinR: 10,
} as const;

/** One rigid body: its anchor bone (the bone whose idle world transform = the body's rest frame), the two seed
 *  particles that define its collision capsule (equal for the head → a sphere), and the GLB bones it carries. */
export const RAGDOLL_BODIES: readonly {
  readonly name: string;
  readonly anchorBone: string;
  readonly capStart: number;
  readonly capEnd: number;
  readonly bones: readonly string[];
}[] = [
  { name: 'pelvis', anchorBone: 'Hips', capStart: RP.pelvis, capEnd: RP.chest, bones: ['Hips', 'Spine', 'Spine01'] },
  { name: 'chest', anchorBone: 'Spine02', capStart: RP.chest, capEnd: RP.head, bones: ['Spine02', 'LeftShoulder', 'RightShoulder'] },
  { name: 'head', anchorBone: 'Head', capStart: RP.head, capEnd: RP.head, bones: ['neck', 'Head', 'head_end', 'headfront'] },
  { name: 'upperArmL', anchorBone: 'LeftArm', capStart: RP.shoulderL, capEnd: RP.elbowL, bones: ['LeftArm'] },
  { name: 'lowerArmL', anchorBone: 'LeftForeArm', capStart: RP.elbowL, capEnd: RP.handL, bones: ['LeftForeArm', 'LeftHand'] },
  { name: 'upperArmR', anchorBone: 'RightArm', capStart: RP.shoulderR, capEnd: RP.elbowR, bones: ['RightArm'] },
  { name: 'lowerArmR', anchorBone: 'RightForeArm', capStart: RP.elbowR, capEnd: RP.handR, bones: ['RightForeArm', 'RightHand'] },
  { name: 'thighL', anchorBone: 'LeftUpLeg', capStart: RP.hipL, capEnd: RP.kneeL, bones: ['LeftUpLeg'] },
  { name: 'shinL', anchorBone: 'LeftLeg', capStart: RP.kneeL, capEnd: RP.footL, bones: ['LeftLeg', 'LeftFoot', 'LeftToeBase'] },
  { name: 'thighR', anchorBone: 'RightUpLeg', capStart: RP.hipR, capEnd: RP.kneeR, bones: ['RightUpLeg'] },
  { name: 'shinR', anchorBone: 'RightLeg', capStart: RP.kneeR, capEnd: RP.footR, bones: ['RightLeg', 'RightFoot', 'RightToeBase'] },
];

/** Joints: (parent body, child body) coincident at the shared joint particle's seed position. */
export const RAGDOLL_JOINTS: readonly { readonly parent: number; readonly child: number; readonly particle: number }[] = [
  { parent: RAGDOLL_BODY_INDEX.pelvis, child: RAGDOLL_BODY_INDEX.chest, particle: RP.chest },
  { parent: RAGDOLL_BODY_INDEX.chest, child: RAGDOLL_BODY_INDEX.head, particle: RP.head },
  { parent: RAGDOLL_BODY_INDEX.chest, child: RAGDOLL_BODY_INDEX.upperArmL, particle: RP.shoulderL },
  { parent: RAGDOLL_BODY_INDEX.upperArmL, child: RAGDOLL_BODY_INDEX.lowerArmL, particle: RP.elbowL },
  { parent: RAGDOLL_BODY_INDEX.chest, child: RAGDOLL_BODY_INDEX.upperArmR, particle: RP.shoulderR },
  { parent: RAGDOLL_BODY_INDEX.upperArmR, child: RAGDOLL_BODY_INDEX.lowerArmR, particle: RP.elbowR },
  { parent: RAGDOLL_BODY_INDEX.pelvis, child: RAGDOLL_BODY_INDEX.thighL, particle: RP.hipL },
  { parent: RAGDOLL_BODY_INDEX.thighL, child: RAGDOLL_BODY_INDEX.shinL, particle: RP.kneeL },
  { parent: RAGDOLL_BODY_INDEX.pelvis, child: RAGDOLL_BODY_INDEX.thighR, particle: RP.hipR },
  { parent: RAGDOLL_BODY_INDEX.thighR, child: RAGDOLL_BODY_INDEX.shinR, particle: RP.kneeR },
];

/** Deterministic per-corpse PRNG (mulberry32) — seeds the impact jitter so each death is unique yet reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
