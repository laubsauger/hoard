// T6 / V1 / V11 — minimal HUD. PROVES the boundary: every value comes from a NARROW primitive selector
// over a published *ViewSnapshot. The HUD NEVER subscribes to a per-frame world array (no zombie
// positions, no instance buffers) — only throttled snapshot fields the engine deliberately published.

import { usePlayerView, useMapView, useUi } from '../stores/react';

function Vital({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="hbn-vital">
      <span className="hbn-vital__label">{label}</span>
      <span className="hbn-vital__value">{value === null ? '--' : Math.round(value)}</span>
    </div>
  );
}

export function Hud() {
  // V11: each hook subscribes to the smallest practical slice — a single primitive.
  const hudVisible = useUi((s) => s.hudVisible);
  const health = usePlayerView((s) => s.snapshot?.health ?? null);
  const bleeding = usePlayerView((s) => s.snapshot?.bleeding ?? null);
  const stress = usePlayerView((s) => s.snapshot?.stress ?? null);
  const hunger = usePlayerView((s) => s.snapshot?.hunger ?? null);
  // Coarse horde pressure counts — NOT entities (V1).
  const visibleZombies = useMapView((s) => s.horde?.visibleCount ?? null);
  const nearestThreat = useMapView((s) => s.horde?.nearestThreatMeters ?? null);

  if (!hudVisible) return null;

  return (
    <div className="hbn-hud" aria-label="heads-up display">
      <div className="hbn-hud__vitals">
        <Vital label="HP" value={health} />
        <Vital label="Bleed" value={bleeding} />
        <Vital label="Stress" value={stress} />
        <Vital label="Hunger" value={hunger} />
      </div>
      <div className="hbn-hud__threat">
        <Vital label="Visible Z" value={visibleZombies} />
        <Vital label="Nearest m" value={nearestThreat} />
      </div>
    </div>
  );
}
