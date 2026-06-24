// T109 / V72 — PASSIVE AWARENESS RADIUS (render-side perception view). A minimum, omnidirectional baseline
// radius around the player within which a clear line of sight reveals the world (and nearby threats), ON TOP
// of the forward flashlight/vision cone. It is NOT a naive circle: the caller still gates every cell on the
// SAME structural `hasLineOfSight` the cone + shots use (V63), so walls/solid props stop it. This module is
// PURE math only — it maps the resolved ambient/sky brightness to the radius. Bright midday → the larger
// `maxRadiusMeters` (you can see all around you on a clear street); night → the smaller `minRadiusMeters`
// (you only see what the flashlight lights + whatever is right beside you). No three/GPU, fully unit-testable.

/** Resolved passive-awareness tunables (subset of the perception config domain). */
export interface PassiveAwarenessConfig {
  /** Radius (m) at full darkness (scene brightness 0) — the night floor. */
  readonly minRadiusMeters: number;
  /** Radius (m) at full daylight (scene brightness 1) — the bright-midday ceiling. */
  readonly maxRadiusMeters: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Passive awareness radius (m) for a normalized scene brightness `brightness01` (the 0..1 day/night key+ambient
 * level the LightingSystem resolves). Linearly interpolates min→max so the radius grows with daylight. Throws
 * on non-finite inputs or an inverted (max < min) config — no silent fallback (a misconfigured radius is a bug,
 * not a thing to paper over). Brightness is clamped to [0,1] so an out-of-range level saturates rather than
 * extrapolating past the configured bounds.
 */
export function passiveRadiusFromAmbient(brightness01: number, cfg: PassiveAwarenessConfig): number {
  if (!Number.isFinite(brightness01)) throw new Error(`brightness01 must be finite, got ${brightness01}`);
  if (!Number.isFinite(cfg.minRadiusMeters) || !Number.isFinite(cfg.maxRadiusMeters)) {
    throw new Error(`passive radius bounds must be finite, got [${cfg.minRadiusMeters}, ${cfg.maxRadiusMeters}]`);
  }
  if (cfg.maxRadiusMeters < cfg.minRadiusMeters) {
    throw new Error(`passive radius max ${cfg.maxRadiusMeters} < min ${cfg.minRadiusMeters}`);
  }
  const t = clamp01(brightness01);
  return cfg.minRadiusMeters + (cfg.maxRadiusMeters - cfg.minRadiusMeters) * t;
}
