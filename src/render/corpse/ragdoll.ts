// T134 / V2 / V24 — PURE, headless-testable PER-LIMB RAGDOLL for dead rigged zombies (no three / no GPU).
//
// A killed rigged corpse goes LIMP and falls under physics instead of the rigid whole-body `corpseTopple`. The
// body is modelled as a small set of POINT MASSES at the skeleton joints (Verlet particles) wired by DISTANCE
// (bone-length) CONSTRAINTS, with GRAVITY, a GROUND PLANE (restitution + friction so it settles, doesn't sink or
// jitter), VELOCITY DAMPING, a few cheap CONE limits (so elbows/knees don't fold into spaghetti), and an INITIAL
// IMPULSE + TORQUE seeded from the killing shot (impactDir·force) so the body tumbles in the shot direction and a
// heavier hit knocks it back farther. Per-corpse variation is seeded ONCE at create from the corpse's entity seed
// (a deterministic PRNG), never `Math.random` inside the integrator, so the same seed+inputs reproduce the same
// fall (render-only V2 — NOT replay-critical, but stable: no NaN, no explosion).
//
// SPACE: the sim runs in the corpse's LOCAL output space — meters, feet near y=0, +Z forward (the bind/idle pose
// the rigged bake produces). The render layer applies the per-instance facing yaw + scale + world translate on top
// (exactly as the old frozen corpse did), so the impulse direction is rotated into this local frame by the caller.
//
// BONE READOUT: each segment is a rigid bone carrying a group of GLB bones. From the segment's current particle
// positions we recover a rigid delta Δ (rotation that maps the segment's SEED direction → its CURRENT direction,
// pivoted at the segment's anchor particle) and emit, per carried bone b, the live skinning matrix
//   M_b = Δ · M0_b
// where M0_b is the BAKED idle skinning matrix (output-local). At rest Δ = I so M_b = M0_b → the exact frozen idle
// pose the corpse used to freeze at; as the particles move the mesh follows rigidly per segment. Column-major
// throughout (matches three's `Matrix4.elements` / the bone DataTexture texel layout: 4 texels = 4 columns).

/** Tunables resolved from config (V4 — no magic numbers in the sim). */
export interface RagdollConfig {
  /** Downward acceleration (m/s²). A touch heavier than 9.8 for game-feel. */
  readonly gravity: number;
  /** Fraction of linear velocity bled per second (air drag). */
  readonly linearDamping: number;
  /** Extra fraction of velocity bled per second once a particle is in ground contact (settling aid). */
  readonly angularDamping: number;
  /** Vertical bounce kept on a ground hit (0 = dead stop, 1 = perfectly elastic). */
  readonly groundRestitution: number;
  /** Horizontal velocity fraction killed per ground-contact step (0 = frictionless, 1 = instant stop). */
  readonly groundFriction: number;
  /** Constraint relaxation iterations per substep (stiffer bones at higher counts). */
  readonly constraintIterations: number;
  /** Verlet substeps per stepped frame (stability vs cost). */
  readonly substeps: number;
  /** force → initial impulse SPEED (m/s) of the upper body along the shot direction. */
  readonly impulseScale: number;
  /** Extra forward speed added per meter of height (the tip-over torque proxy). */
  readonly torqueScale: number;
  /** Per-substep total kinetic proxy below which the body is declared SETTLED (then it stops integrating). */
  readonly settleEnergyThreshold: number;
  /** Minimum included angle (rad) allowed at a cone-limited joint (elbow/knee) — prevents hyper-fold. */
  readonly jointConeRadians: number;
  /** Collision radius (m) of every joint particle against the ground plane (the body rests this far up). */
  readonly groundRadiusMeters: number;
}

/** One rigid segment: a bone group whose orientation is recovered from `dirFrom→dirTo` and pivoted at `anchor`. */
export interface RagdollSegment {
  /** Particle index the segment rotates ABOUT (its world anchor). */
  readonly anchor: number;
  /** Particle index the orientation direction points FROM. */
  readonly dirFrom: number;
  /** Particle index the orientation direction points TO. */
  readonly dirTo: number;
  /** GLB bone indices this segment carries rigidly. */
  readonly bones: readonly number[];
}

/** A distance constraint between two particles, holding a baked rest length. */
interface DistanceConstraint {
  readonly i: number;
  readonly j: number;
  readonly rest: number;
}

/** A cone limit: keep particles a and c at least `minDist` apart so the middle joint b cannot over-fold. */
interface ConeConstraint {
  readonly a: number;
  readonly c: number;
  readonly minDist: number;
}

/** The immutable per-archetype ragdoll definition (topology + bind pose + baked idle matrices). */
export interface RagdollSpec {
  readonly particleCount: number;
  readonly boneCount: number;
  /** Seed (rest) particle positions, output-local meters, length particleCount*3. */
  readonly seed: Float32Array;
  /** Per-particle inverse mass (0 = pinned; all dynamic here). */
  readonly invMass: Float32Array;
  readonly constraints: readonly DistanceConstraint[];
  readonly cones: readonly ConeConstraint[];
  readonly segments: readonly RagdollSegment[];
  /** Baked idle skinning matrices, column-major, length boneCount*16. */
  readonly m0: Float32Array;
}

/** Raw topology input to `buildRagdollSpec` (lengths/cones derived from `seed`). */
export interface RagdollTopology {
  readonly particleCount: number;
  readonly boneCount: number;
  readonly seed: Float32Array;
  readonly m0: Float32Array;
  /** Distance-constraint particle index pairs. */
  readonly links: readonly (readonly [number, number])[];
  /** Cone-limit triples [a, b, c]: b is the middle joint, the a↔c separation is floored. */
  readonly coneTriples: readonly (readonly [number, number, number])[];
  readonly segments: readonly RagdollSegment[];
  /** Optional per-particle inverse mass (defaults to all 1). */
  readonly invMass?: Float32Array;
}

const EPS = 1e-9;

/** Build the immutable spec: rest lengths from the seed, cone min-distances from `jointConeRadians`. PURE. */
export function buildRagdollSpec(topo: RagdollTopology, jointConeRadians: number): RagdollSpec {
  const { seed } = topo;
  const constraints: DistanceConstraint[] = topo.links.map(([i, j]) => ({ i, j, rest: dist(seed, i, j) }));
  const cosCone = Math.cos(jointConeRadians);
  const cones: ConeConstraint[] = topo.coneTriples.map(([a, b, c]) => {
    const lab = dist(seed, a, b);
    const lbc = dist(seed, b, c);
    // Law of cosines: the a↔c distance when the joint at b is folded to its tightest allowed angle.
    const minDist = Math.sqrt(Math.max(0, lab * lab + lbc * lbc - 2 * lab * lbc * cosCone));
    return { a, c, minDist };
  });
  const invMass = topo.invMass ?? new Float32Array(topo.particleCount).fill(1);
  return {
    particleCount: topo.particleCount,
    boneCount: topo.boneCount,
    seed,
    invMass,
    constraints,
    cones,
    segments: topo.segments,
    m0: topo.m0,
  };
}

/**
 * One corpse's live ragdoll state. Pooled + reset in place (no per-death allocation after warm-up, V24). All
 * scratch buffers are sized to the spec at construction; `reset` re-seeds them for a fresh fall.
 */
export class Ragdoll {
  /** Owning archetype spec (set on reset; lets the pool stay archetype-agnostic). */
  spec: RagdollSpec;
  readonly pos: Float32Array;
  readonly prev: Float32Array;
  /** Initial velocity to inject on the first stepped substep (impulse + torque), output-local m per substep-dt. */
  private readonly vel0: Float32Array;
  private started = false;
  /** Cached emitted bone matrices (column-major, boneCount*16) — refreshed only while moving. */
  readonly bones: Float32Array;
  settled = false;
  /** Liveness generation for the owning pool (set by the caller each frame it is seen). */
  gen = -1;

  constructor(spec: RagdollSpec) {
    this.spec = spec;
    const n = spec.particleCount;
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.vel0 = new Float32Array(n * 3);
    this.bones = new Float32Array(spec.boneCount * 16);
  }

  /**
   * (Re)seed this ragdoll for a fresh death. Places particles at the bind/idle pose and computes the per-particle
   * launch velocity from the LOCAL impact direction + force + a deterministic per-corpse PRNG (`rand`, returns
   * [0,1)). A higher `force` injects more upper-body speed (knockback) and more tip-over torque. A force-less death
   * crumples gently forward (local +Z) under gravity. PURE w.r.t. `rand` — no Math.random.
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
    const seed = spec.seed;
    this.pos.set(seed);
    this.prev.set(seed);
    this.bones.set(spec.m0); // rest pose until first step

    // Body height (max seed y) drives the height-scaled tip-over torque.
    let height = 0;
    for (let p = 0; p < spec.particleCount; p++) height = Math.max(height, seed[p * 3 + 1]!);
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
      dz = 1; // crumple forward along the body's own facing
    }
    // Per-corpse jitter (deterministic): rotate the push a few degrees + vary the magnitude so no two falls match.
    const jitterAng = (rand() - 0.5) * 0.5; // ±~14°
    const ca = Math.cos(jitterAng);
    const sa = Math.sin(jitterAng);
    const jx = ca * dx - sa * dz;
    const jz = sa * dx + ca * dz;
    dx = jx;
    dz = jz;
    const magJitter = 0.85 + rand() * 0.3; // ±15% speed
    const launch = (force > 0 ? cfg.impulseScale * force : cfg.impulseScale * 0.6) * magJitter;

    this.vel0.fill(0);
    for (let p = 0; p < spec.particleCount; p++) {
      if (spec.invMass[p]! <= 0) continue;
      const y = seed[p * 3 + 1]!;
      // Height-scaled forward speed: the head/chest lead, the feet lag → the body tips over and tumbles.
      const torque = 1 + cfg.torqueScale * y * invH;
      const speed = launch * torque;
      // A small per-particle asymmetry (seeded) keeps the limbs flopping uniquely, not as a rigid plank.
      const wobble = 1 + (rand() - 0.5) * 0.25;
      this.vel0[p * 3] = dx * speed * wobble;
      this.vel0[p * 3 + 1] = 0; // no launch lift — gravity owns the vertical; the topple lifts the body naturally
      this.vel0[p * 3 + 2] = dz * speed * wobble;
    }
  }

  /**
   * Advance the sim by `dt` seconds (split into `cfg.substeps` Verlet substeps). On the FIRST step the seeded
   * launch velocity is injected (prev = pos − vel0). Sets `settled` once the per-substep kinetic proxy decays
   * below the threshold; a settled ragdoll should not be stepped again (the caller stops). NaN-safe. PURE.
   */
  step(cfg: RagdollConfig, dt: number): void {
    if (this.settled || !(dt > 0)) return;
    const spec = this.spec;
    const sub = Math.max(1, cfg.substeps | 0);
    const h = dt / sub;
    if (!this.started) {
      // Inject the launch velocity using the first substep dt: prev = pos − vel0·h (Verlet velocity = pos − prev).
      for (let k = 0; k < spec.particleCount * 3; k++) this.prev[k] = this.pos[k]! - this.vel0[k]! * h;
      this.started = true;
    }
    let energy = 0;
    for (let s = 0; s < sub; s++) energy = this.substep(cfg, h);
    // Declare settled only after motion has actually decayed (energy is the LAST substep's kinetic proxy).
    if (energy < cfg.settleEnergyThreshold) this.settled = true;
  }

  /** One Verlet substep: integrate → relax distance constraints → cone limits → ground. Returns kinetic proxy. */
  private substep(cfg: RagdollConfig, h: number): number {
    const spec = this.spec;
    const P = this.pos;
    const PV = this.prev;
    const im = spec.invMass;
    const n = spec.particleCount;
    const g = cfg.gravity;
    const airDamp = clamp01(1 - cfg.linearDamping * h);
    const r = cfg.groundRadiusMeters;
    const gh2 = -g * h * h;

    // --- Integrate (Verlet with air damping + gravity) ---
    for (let p = 0; p < n; p++) {
      if (im[p]! <= 0) continue;
      const b = p * 3;
      for (let a = 0; a < 3; a++) {
        const cur = P[b + a]!;
        const vel = (cur - PV[b + a]!) * airDamp;
        PV[b + a] = cur;
        P[b + a] = cur + vel + (a === 1 ? gh2 : 0);
      }
    }

    // --- Distance constraints (bone lengths) ---
    const iters = Math.max(1, cfg.constraintIterations | 0);
    const cons = spec.constraints;
    for (let it = 0; it < iters; it++) {
      for (let c = 0; c < cons.length; c++) {
        const { i, j, rest } = cons[c]!;
        satisfyDistance(P, im, i, j, rest, false);
      }
      // Cone limits: floor the a↔c separation so the joint cannot fold through itself.
      const cones = spec.cones;
      for (let c = 0; c < cones.length; c++) {
        const { a, c: cc, minDist } = cones[c]!;
        satisfyMinDistance(P, im, a, cc, minDist);
      }
    }

    // --- Ground plane (y >= radius) with restitution + friction so it settles ---
    const restitution = cfg.groundRestitution;
    const groundDamp = clamp01(1 - cfg.angularDamping * h);
    for (let p = 0; p < n; p++) {
      if (im[p]! <= 0) continue;
      const b = p * 3;
      if (P[b + 1]! < r) {
        P[b + 1] = r;
        // Vertical bounce: reflect the incoming downward velocity, scaled by restitution.
        const py = PV[b + 1]!;
        PV[b + 1] = r - restitution * (py - r);
        // Horizontal friction + extra contact damping (kills sliding/jitter so the body comes to rest).
        const fr = clamp01(1 - cfg.groundFriction);
        PV[b] = P[b]! - (P[b]! - PV[b]!) * fr * groundDamp;
        PV[b + 2] = P[b + 2]! - (P[b + 2]! - PV[b + 2]!) * fr * groundDamp;
      }
    }

    // --- Kinetic proxy: Σ |pos − prev|² (per-substep squared displacement). ---
    let energy = 0;
    for (let k = 0; k < n * 3; k++) {
      const d = P[k]! - PV[k]!;
      energy += d * d;
    }
    return energy;
  }

  /**
   * Recompute the cached live bone matrices from the current particle positions (M_b = Δ_seg · M0_b, column-major)
   * and copy them into `out` at `outOffset` (length boneCount*16). Skips the recompute when settled (the cached
   * frozen matrices are reused), so a settled corpse whose texture ROW changed still uploads correct data cheaply.
   */
  writeBones(out: Float32Array, outOffset: number): void {
    if (!this.settled) this.recomputeBones();
    out.set(this.bones, outOffset);
  }

  /** Fill `this.bones` from the current segment orientations. NaN-safe. */
  private recomputeBones(): void {
    const spec = this.spec;
    const seed = spec.seed;
    const P = this.pos;
    const out = this.bones;
    const R = _R;
    const dSeed = _dSeed;
    const dNow = _dNow;
    const t = _t;
    const tmp = _m;
    for (let s = 0; s < spec.segments.length; s++) {
      const seg = spec.segments[s]!;
      sub3(dSeed, seed, seg.dirTo, seed, seg.dirFrom);
      sub3(dNow, P, seg.dirTo, P, seg.dirFrom);
      normalize3(dSeed);
      normalize3(dNow);
      rotationBetween(R, dSeed, dNow);
      // t = anchor_now − R · anchor_seed  (Δ = R with translation t; pivots the segment at its anchor)
      const ax = seed[seg.anchor * 3]!;
      const ay = seed[seg.anchor * 3 + 1]!;
      const az = seed[seg.anchor * 3 + 2]!;
      t[0] = P[seg.anchor * 3]! - (R[0]! * ax + R[1]! * ay + R[2]! * az);
      t[1] = P[seg.anchor * 3 + 1]! - (R[3]! * ax + R[4]! * ay + R[5]! * az);
      t[2] = P[seg.anchor * 3 + 2]! - (R[6]! * ax + R[7]! * ay + R[8]! * az);
      // Δ (column-major 4x4) from R (row-major 3x3) + translation t.
      buildDelta(tmp, R, t);
      for (let k = 0; k < seg.bones.length; k++) {
        const b = seg.bones[k]!;
        mul4(out, b * 16, tmp, spec.m0, b * 16);
      }
    }
  }
}

// ---- Scratch (module-level, reused — no per-frame allocation in the hot loop, V24) ----
const _R = new Float64Array(9); // row-major 3x3
const _dSeed = new Float64Array(3);
const _dNow = new Float64Array(3);
const _t = new Float64Array(3);
const _m = new Float64Array(16); // column-major Δ

function dist(seed: Float32Array, i: number, j: number): number {
  const dx = seed[i * 3]! - seed[j * 3]!;
  const dy = seed[i * 3 + 1]! - seed[j * 3 + 1]!;
  const dz = seed[i * 3 + 2]! - seed[j * 3 + 2]!;
  return Math.hypot(dx, dy, dz);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Move particles i,j so |i−j| == rest (weighted by inverse mass). `minOnly` only pushes apart when too close. */
function satisfyDistance(P: Float32Array, im: Float32Array, i: number, j: number, rest: number, minOnly: boolean): void {
  const bi = i * 3;
  const bj = j * 3;
  const dx = P[bj]! - P[bi]!;
  const dy = P[bj + 1]! - P[bi + 1]!;
  const dz = P[bj + 2]! - P[bi + 2]!;
  const d = Math.hypot(dx, dy, dz);
  if (d < EPS) return;
  if (minOnly && d >= rest) return;
  const wi = im[i]!;
  const wj = im[j]!;
  const wsum = wi + wj;
  if (wsum <= 0) return;
  const diff = (d - rest) / d;
  const si = (wi / wsum) * diff;
  const sj = (wj / wsum) * diff;
  P[bi] = P[bi]! + dx * si;
  P[bi + 1] = P[bi + 1]! + dy * si;
  P[bi + 2] = P[bi + 2]! + dz * si;
  P[bj] = P[bj]! - dx * sj;
  P[bj + 1] = P[bj + 1]! - dy * sj;
  P[bj + 2] = P[bj + 2]! - dz * sj;
}

function satisfyMinDistance(P: Float32Array, im: Float32Array, i: number, j: number, minDist: number): void {
  satisfyDistance(P, im, i, j, minDist, true);
}

function sub3(out: Float64Array, a: Float32Array, ai: number, b: Float32Array, bi: number): void {
  out[0] = a[ai * 3]! - b[bi * 3]!;
  out[1] = a[ai * 3 + 1]! - b[bi * 3 + 1]!;
  out[2] = a[ai * 3 + 2]! - b[bi * 3 + 2]!;
}

function normalize3(v: Float64Array): void {
  const m = Math.hypot(v[0]!, v[1]!, v[2]!);
  if (m < EPS) {
    v[0] = 0;
    v[1] = 1;
    v[2] = 0;
    return;
  }
  v[0]! /= m;
  v[1]! /= m;
  v[2]! /= m;
}

/** Row-major 3x3 rotation taking unit vector `a` → unit vector `b` (Rodrigues closed form). NaN-safe. */
function rotationBetween(R: Float64Array, a: Float64Array, b: Float64Array): void {
  const vx = a[1]! * b[2]! - a[2]! * b[1]!;
  const vy = a[2]! * b[0]! - a[0]! * b[2]!;
  const vz = a[0]! * b[1]! - a[1]! * b[0]!;
  const c = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  if (c > 0.999999) {
    R[0] = 1; R[1] = 0; R[2] = 0;
    R[3] = 0; R[4] = 1; R[5] = 0;
    R[6] = 0; R[7] = 0; R[8] = 1;
    return;
  }
  if (c < -0.999999) {
    // 180°: rotate about any axis perpendicular to a → R = 2·p·pᵀ − I.
    let px = -a[1]!, py = a[0]!, pz = 0;
    if (Math.hypot(px, py, pz) < EPS) { px = 0; py = -a[2]!; pz = a[1]!; }
    const pm = Math.hypot(px, py, pz) || 1;
    px /= pm; py /= pm; pz /= pm;
    R[0] = 2 * px * px - 1; R[1] = 2 * px * py; R[2] = 2 * px * pz;
    R[3] = 2 * py * px; R[4] = 2 * py * py - 1; R[5] = 2 * py * pz;
    R[6] = 2 * pz * px; R[7] = 2 * pz * py; R[8] = 2 * pz * pz - 1;
    return;
  }
  const k = 1 / (1 + c);
  // R = c·I + [v]× + k·v·vᵀ   (row-major)
  R[0] = c + vx * vx * k;
  R[1] = -vz + vx * vy * k;
  R[2] = vy + vx * vz * k;
  R[3] = vz + vy * vx * k;
  R[4] = c + vy * vy * k;
  R[5] = -vx + vy * vz * k;
  R[6] = -vy + vz * vx * k;
  R[7] = vx + vz * vy * k;
  R[8] = c + vz * vz * k;
}

/** Δ (column-major 4x4) from a row-major 3x3 rotation `R` and translation `t`. */
function buildDelta(out: Float64Array, R: Float64Array, t: Float64Array): void {
  out[0] = R[0]!; out[1] = R[3]!; out[2] = R[6]!; out[3] = 0;
  out[4] = R[1]!; out[5] = R[4]!; out[6] = R[7]!; out[7] = 0;
  out[8] = R[2]!; out[9] = R[5]!; out[10] = R[8]!; out[11] = 0;
  out[12] = t[0]!; out[13] = t[1]!; out[14] = t[2]!; out[15] = 1;
}

/** out[outOff..+16] = A · B[bOff..+16]  (all column-major 4x4). out and B may alias different ranges. */
function mul4(out: Float32Array, outOff: number, A: Float64Array, B: Float32Array, bOff: number): void {
  for (let col = 0; col < 4; col++) {
    const b0 = B[bOff + col * 4]!;
    const b1 = B[bOff + col * 4 + 1]!;
    const b2 = B[bOff + col * 4 + 2]!;
    const b3 = B[bOff + col * 4 + 3]!;
    out[outOff + col * 4] = A[0]! * b0 + A[4]! * b1 + A[8]! * b2 + A[12]! * b3;
    out[outOff + col * 4 + 1] = A[1]! * b0 + A[5]! * b1 + A[9]! * b2 + A[13]! * b3;
    out[outOff + col * 4 + 2] = A[2]! * b0 + A[6]! * b1 + A[10]! * b2 + A[14]! * b3;
    out[outOff + col * 4 + 3] = A[3]! * b0 + A[7]! * b1 + A[11]! * b2 + A[15]! * b3;
  }
}

// ---- HUMANOID TOPOLOGY (GLB-agnostic): 15 joint particles, 12 rigid segments. The segment bone groups name the
// Mixamo bones (identical across all three zombie GLBs); `rigged.ts` resolves the names → skeleton indices. Pure
// data — no three / no GPU — so it is unit-testable with a synthetic seed pose. ----

/** Joint particle indices (output-local). */
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

/** Segment → (anchor, dirFrom, dirTo, carried Mixamo bone names). Covers all 24 bones. */
export const RAGDOLL_SEGMENT_BONES: readonly {
  readonly anchor: number;
  readonly dirFrom: number;
  readonly dirTo: number;
  readonly bones: readonly string[];
}[] = [
  { anchor: RP.pelvis, dirFrom: RP.pelvis, dirTo: RP.chest, bones: ['Hips'] },
  { anchor: RP.pelvis, dirFrom: RP.pelvis, dirTo: RP.chest, bones: ['Spine', 'Spine01'] },
  { anchor: RP.chest, dirFrom: RP.chest, dirTo: RP.head, bones: ['Spine02', 'LeftShoulder', 'RightShoulder'] },
  { anchor: RP.head, dirFrom: RP.chest, dirTo: RP.head, bones: ['neck', 'Head', 'head_end', 'headfront'] },
  { anchor: RP.shoulderL, dirFrom: RP.shoulderL, dirTo: RP.elbowL, bones: ['LeftArm'] },
  { anchor: RP.elbowL, dirFrom: RP.elbowL, dirTo: RP.handL, bones: ['LeftForeArm', 'LeftHand'] },
  { anchor: RP.shoulderR, dirFrom: RP.shoulderR, dirTo: RP.elbowR, bones: ['RightArm'] },
  { anchor: RP.elbowR, dirFrom: RP.elbowR, dirTo: RP.handR, bones: ['RightForeArm', 'RightHand'] },
  { anchor: RP.hipL, dirFrom: RP.hipL, dirTo: RP.kneeL, bones: ['LeftUpLeg'] },
  { anchor: RP.kneeL, dirFrom: RP.kneeL, dirTo: RP.footL, bones: ['LeftLeg', 'LeftFoot', 'LeftToeBase'] },
  { anchor: RP.hipR, dirFrom: RP.hipR, dirTo: RP.kneeR, bones: ['RightUpLeg'] },
  { anchor: RP.kneeR, dirFrom: RP.kneeR, dirTo: RP.footR, bones: ['RightLeg', 'RightFoot', 'RightToeBase'] },
];

/** Distance-constraint links: skeleton bones + torso cross-braces (keep the trunk a semi-rigid truss). */
export const RAGDOLL_LINKS: readonly (readonly [number, number])[] = [
  // skeleton bones
  [RP.pelvis, RP.chest], [RP.chest, RP.head],
  [RP.pelvis, RP.hipL], [RP.pelvis, RP.hipR],
  [RP.chest, RP.shoulderL], [RP.chest, RP.shoulderR],
  [RP.shoulderL, RP.elbowL], [RP.elbowL, RP.handL],
  [RP.shoulderR, RP.elbowR], [RP.elbowR, RP.handR],
  [RP.hipL, RP.kneeL], [RP.kneeL, RP.footL],
  [RP.hipR, RP.kneeR], [RP.kneeR, RP.footR],
  // trunk cross-braces (rigidity)
  [RP.pelvis, RP.shoulderL], [RP.pelvis, RP.shoulderR],
  [RP.chest, RP.hipL], [RP.chest, RP.hipR],
  [RP.shoulderL, RP.shoulderR], [RP.hipL, RP.hipR],
];

/** Cone-limited joints [a, b, c]: floor the a↔c separation so elbows/knees/neck cannot fold through. */
export const RAGDOLL_CONES: readonly (readonly [number, number, number])[] = [
  [RP.shoulderL, RP.elbowL, RP.handL],
  [RP.shoulderR, RP.elbowR, RP.handR],
  [RP.hipL, RP.kneeL, RP.footL],
  [RP.hipR, RP.kneeR, RP.footR],
  [RP.pelvis, RP.chest, RP.head],
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
