// Damage screen feedback: an organic red radial vignette (transparent centre → blood-red at the edges). Two
// stacked layers, both pointer-events:none overlays (V1 — never own world state):
//   1. a PERSISTENT low-HP tint whose strength grows as health falls (the world reads bloodier the closer to
//      death), eased so HP changes don't pop;
//   2. an on-hit FLARE that flares the instant the HUD health snapshot DROPS and fades out slowly, with its
//      peak scaled by BOTH the hit size and how low health already is (a hit at 10 HP hits harder than at full).
// Detects damage by watching the health snapshot fall, so no engine wiring. Self-contained inline styles.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { usePlayerView } from '../stores/react';

/** HUD health scale: the HP vital reads 0..100 (no max in the snapshot), so normalise against this. */
const HEALTH_FULL = 100;
/** Below this HP fraction the persistent low-HP tint begins ramping in (half health). */
const LOW_HP_START = 0.5;
/** Opacity of the persistent tint at 0 HP (it ramps 0 → this between LOW_HP_START and empty). */
const BASELINE_MAX = 0.42;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Organic blood vignette: clear centre, deepening to red at the frame edges. Inner stop pulled in (26%) so the
 *  red reaches further toward the centre; the size (>100%) pushes the darkest ring past the corners. */
const GRADIENT =
  'radial-gradient(135% 108% at 50% 50%, rgba(140, 0, 0, 0) 26%, rgba(150, 8, 8, 0.34) 62%, rgba(108, 0, 0, 0.80) 100%)';
const EDGE_SHADOW = 'inset 0 0 220px 60px rgba(120, 0, 0, 0.5)';

/** Peak flare opacity for one hit: a floor so any chip registers, scaled by hit size AND amplified as health
 *  drops (the same hit reads more violent when you are already near death). */
function flarePeak(damage: number, hpFrac: number): number {
  const base = Math.min(0.6, 0.16 + damage / 45);
  return Math.min(0.88, base * (1 + (1 - hpFrac) * 0.9));
}

export function DamageVignette() {
  const health = usePlayerView((s) => s.snapshot?.health ?? null);
  const prev = useRef<number | null>(health);
  const [flare, setFlare] = useState(0);
  const [fading, setFading] = useState(false);

  const hpFrac = health == null ? 1 : clamp01(health / HEALTH_FULL);
  const baseline = hpFrac >= LOW_HP_START ? 0 : ((LOW_HP_START - hpFrac) / LOW_HP_START) * BASELINE_MAX;

  useEffect(() => {
    const last = prev.current;
    prev.current = health;
    if (last == null || health == null) return;
    if (health >= last) return; // healed or unchanged — no flare
    // Instant rise to the hit's peak (transition OFF), then next frame fall to 0 (transition ON) → a sharp hit
    // followed by an organic, slower fade.
    setFading(false);
    setFlare(flarePeak(last - health, clamp01(health / HEALTH_FULL)));
    const raf = requestAnimationFrame(() => {
      setFading(true);
      setFlare(0);
    });
    return () => cancelAnimationFrame(raf);
  }, [health]);

  const layer = (opacity: number, transition: string): CSSProperties => ({
    position: 'fixed',
    inset: 0,
    zIndex: 60,
    pointerEvents: 'none',
    opacity,
    transition,
    background: GRADIENT,
    boxShadow: EDGE_SHADOW,
  });

  return (
    <>
      {/* persistent low-HP tint — eases when HP changes so it doesn't pop */}
      <div aria-hidden style={layer(baseline, 'opacity 500ms ease-out')} />
      {/* on-hit flare — instant rise, slow organic fade */}
      <div aria-hidden style={layer(flare, fading ? 'opacity 1150ms cubic-bezier(0.22, 0.61, 0.36, 1)' : 'none')} />
    </>
  );
}
