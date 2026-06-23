// V1 / V11 — at-a-glance noise meter. Reads a narrow throttled snapshot (NOT per-frame world state): the
// outer arc = how loud it is AROUND the player (green → amber → red); the pulsing core = how much noise the
// PLAYER is producing right now. Stealth read in one glance — loud means the horde can hear you.

import { useNoiseView } from '../stores/react';

const R = 26;
const C = 2 * Math.PI * R;

/** Ambient 0..1 → hue green(120)→amber(60)→red(0). */
function arcColor(v: number): string {
  const hue = 120 * (1 - Math.min(1, Math.max(0, v)));
  return `hsl(${hue}, 75%, 52%)`;
}

export function NoiseMeter() {
  const ambient = useNoiseView((s) => s.snapshot?.ambient01 ?? 0);
  const self = useNoiseView((s) => s.snapshot?.self01 ?? 0);
  const col = arcColor(ambient);

  return (
    <div
      className={`hbn-noise${ambient > 0.66 ? ' is-loud' : ''}`}
      aria-label={`Surrounding noise ${Math.round(ambient * 100)} percent`}
    >
      <svg viewBox="0 0 64 64" className="hbn-noise__svg" role="img">
        <circle cx="32" cy="32" r={R} className="hbn-noise__track" />
        <circle
          cx="32"
          cy="32"
          r={R}
          className="hbn-noise__arc"
          stroke={col}
          strokeDasharray={`${ambient * C} ${C}`}
          transform="rotate(-90 32 32)"
        />
        <circle
          cx="32"
          cy="32"
          r={5 + self * 11}
          className="hbn-noise__self"
          style={{ opacity: 0.2 + 0.7 * self }}
        />
      </svg>
      <span className="hbn-noise__label">NOISE</span>
    </div>
  );
}
