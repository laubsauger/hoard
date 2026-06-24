// Damage screen feedback: an organic red radial vignette (transparent centre → blood-red at the edges) that
// flares when the player's HP DROPS and fades out, so taking damage reads instantly without a HUD glance. Pure
// overlay (pointer-events: none, V1 — never owns world state); detects damage by watching the HUD health
// snapshot fall, so no engine wiring is needed. Self-contained styles (no shared CSS) to stay collision-free.

import { useEffect, useRef, useState } from 'react';
import { usePlayerView } from '../stores/react';

/** Peak opacity per hit: a small floor so any chip registers, scaled up by how big the hit was. */
function peakFor(damage: number): number {
  return Math.min(0.62, 0.18 + damage / 45);
}

export function DamageVignette() {
  const health = usePlayerView((s) => s.snapshot?.health ?? null);
  const prev = useRef<number | null>(health);
  const [opacity, setOpacity] = useState(0);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const last = prev.current;
    prev.current = health;
    if (last == null || health == null) return;
    if (health >= last) return; // healed or unchanged — no flare
    // Instant rise to the hit's peak (transition OFF), then next frame fall to 0 (transition ON) → a sharp
    // hit followed by an organic fade.
    setFading(false);
    setOpacity(peakFor(last - health));
    const raf = requestAnimationFrame(() => {
      setFading(true);
      setOpacity(0);
    });
    return () => cancelAnimationFrame(raf);
  }, [health]);

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        pointerEvents: 'none',
        opacity,
        transition: fading ? 'opacity 720ms cubic-bezier(0.22, 0.61, 0.36, 1)' : 'none',
        // Clear in the centre, deepening to blood-red at the frame edges (an irregular ellipse reads organic).
        background:
          'radial-gradient(125% 95% at 50% 48%, rgba(140, 0, 0, 0) 38%, rgba(150, 6, 6, 0.30) 72%, rgba(112, 0, 0, 0.72) 100%)',
        // A second, tighter corner darkening so the edges feel heavier than a single even ring.
        boxShadow: 'inset 0 0 180px 40px rgba(120, 0, 0, 0.45)',
      }}
    />
  );
}
