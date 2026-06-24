// T131 / V99 — PURE impact-directional death TOPPLE (no three / no GPU). A killed zombie does not snap to the
// floor: it TIPS OVER about a horizontal axis, FALLING in the killing shot's push direction (a shot from the
// front knocks it onto its back, from behind onto its face, from the side topples it sideways), pivoting at the
// feet and settling flat under a smooth, gravity-like ease (V87/V88 kept). A heavier hit topples FASTER (more
// initial tumble); a force-less death (melee / lifetime expiry) crumples FORWARD along its own heading — the
// prior "straight-down" collapse. Fully deterministic (V26): same inputs → same pose every frame. The render
// lane feeds (pitch, fallYaw, lift) per corpse into the rigged GPU-skinning shader, which applies the topple.

/** Lift (m) a fully-prone body sits above the ground so it rests ON the surface (mirrors the old corpse clearance). */
export const CORPSE_LIE_HEIGHT = 0.18;
/** A full topple lays the standing figure flat — the pitch sweeps 0 (upright) → 90° (prone). */
export const CORPSE_PRONE_PITCH = Math.PI / 2;
/** Force saturation reference (effective-damage units): the force at which the tumble boost reaches HALF its max.
 *  Raised so an ordinary kill barely accelerates the fall — only an overwhelming hit shows extra momentum (a body
 *  should crumple, not get launched like a cannonball). */
export const CORPSE_FORCE_HALF = 60;
/** Max fraction the effective collapse time is shortened by an overwhelming hit — kept SMALL so force is a subtle
 *  nudge to the timing, not a violent fling. */
export const CORPSE_TUMBLE_GAIN = 0.35;
/** Render-only stretch of the collapse window so the body CRUMPLES over a beat rather than slamming flat in a blink. */
export const CORPSE_CRUMPLE_STRETCH = 1.35;
/** Damping ratio of the topple's organic settle — underdamped, so the body slightly OVER-rotates past flat then
 *  rocks back to rest (a ragdoll-ish settle), instead of stopping dead like a rigid plank. */
export const TOPPLE_DAMPING = 0.66;
/** Natural frequency (per normalized-progress unit) of the settle — tuned so the body gives, falls, over-rotates
 *  ONCE (~6°), and has rocked back to rest by the end of the (stretched) window. */
export const TOPPLE_FREQUENCY = 10;

/**
 * Death-collapse progress 0..1 (T122/V87): how far a fresh corpse has toppled from standing → prone, by tick age.
 * 0 = just died (still upright, where the live figure stood); 1 = fully settled flat. Pure / deterministic (V26).
 */
export function collapseProgress(ageTicks: number, collapseTicks: number): number {
  if (collapseTicks <= 0) return 1;
  const t = ageTicks / collapseTicks;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Smoothstep ease (T122/V87) — a soft start + soft landing. Kept for the blob `CorpseField` fallback. Pure. */
export function collapseEase(p: number): number {
  const x = p < 0 ? 0 : p > 1 ? 1 : p;
  return x * x * (3 - 2 * x);
}

/**
 * T131/V99 — the ORGANIC topple ease for the rigged corpse: a damped second-order (mass-on-a-spring) step response.
 * It starts at rest with ZERO velocity (the body GIVES gently rather than snapping over), accelerates as it falls
 * (gravity), slightly OVER-rotates past flat (momentum carries it ~6° past prone), then ROCKS BACK and settles to
 * rest — reading as a ragdoll crumple + organic settle, not a stiff plank slamming to a hard stop. Can exceed 1
 * mid-fall (the over-rotation); ends ≈1 and is clamped to exactly 1 once settled. PURE + deterministic (V26).
 */
export function toppleEase(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const z = TOPPLE_DAMPING;
  const wn = TOPPLE_FREQUENCY;
  const wd = wn * Math.sqrt(1 - z * z);
  const decay = Math.exp(-z * wn * p);
  return 1 - decay * (Math.cos(wd * p) + ((z * wn) / wd) * Math.sin(wd * p));
}

/** Normalize a raw impact force (effective damage) to a bounded [0,1) tumble factor — saturating, so a huge hit
 *  can't fling the body unboundedly while a light tap still nudges it (V26). PURE: 0 force → 0. */
export function toppleForceFactor(force: number): number {
  if (!(force > 0)) return 0;
  return force / (force + CORPSE_FORCE_HALF);
}

/** The resolved topple pose for a corpse this frame. `fallYaw` is the WORLD yaw the body tips TOWARD (head leads). */
export interface ToppleState {
  /** Topple angle about the (horizontal) fall axis — 0 upright, `CORPSE_PRONE_PITCH` flat. */
  readonly pitch: number;
  /** World yaw of the direction the body falls toward (atan2(dirZ,dirX) for a shot; the body's heading for force 0). */
  readonly fallYaw: number;
  /** Ground clearance, eased 0 → `CORPSE_LIE_HEIGHT` with the pitch, so the settled body rests ON the surface. */
  readonly lift: number;
}

/**
 * Resolve a corpse's impact-directional topple for the given tick age. PURE + deterministic (V26).
 *
 * - DIRECTION: a real shot (force > 0) pushes the body ALONG the bullet's travel direction `(impactDirX, impactDirZ)`
 *   — since the bullet flies from the shooter THROUGH the body, a front shot lays it onto its BACK, a shot from
 *   behind onto its FACE, a side shot topples it SIDEWAYS. A force-less death (melee / expiry) has no push, so the
 *   body crumples FORWARD along its own `heading` (the prior V87/V88 "straight-down" collapse).
 * - MOTION: the body GIVES, falls, over-rotates ~6° past flat, then rocks back to rest (`toppleEase`, a damped
 *   spring settle) — an organic crumple, not a rigid plank slam. A heavier hit only SUBTLY shortens the fall (small
 *   `CORPSE_TUMBLE_GAIN`); the crumple window is gently stretched (`CORPSE_CRUMPLE_STRETCH`) so it doesn't blink flat.
 */
export function corpseTopple(
  impactDirX: number,
  impactDirZ: number,
  force: number,
  ageTicks: number,
  collapseTicks: number,
  heading: number,
): ToppleState {
  const mag = Math.hypot(impactDirX, impactDirZ);
  const fallYaw = force > 0 && mag > 1e-6 ? Math.atan2(impactDirZ, impactDirX) : heading;
  const boost = 1 + CORPSE_TUMBLE_GAIN * toppleForceFactor(force);
  const progress = collapseProgress(ageTicks * boost, collapseTicks * CORPSE_CRUMPLE_STRETCH);
  const eased = toppleEase(progress);
  // Pitch follows the full (over-rotating) settle; the ground clearance is monotonic (never floats the body up
  // on the over-rotation), so a settled body always rests ON the surface.
  return { pitch: eased * CORPSE_PRONE_PITCH, fallYaw, lift: CORPSE_LIE_HEIGHT * Math.min(1, eased) };
}
