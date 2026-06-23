// T60/V29 — the highlight's pure appearance helpers: colour-coded by kind, pulsing between min/max, damped to
// a steady glow when reduce-flashes / reduce-motion is set. GPU-free (no renderer).
import { describe, it, expect } from 'vitest';
import { resolveHighlightSettings, highlightColorFor, highlightPulseIntensity } from './highlightView';
import type { TargetKind } from '../../game/interaction';

const settings = resolveHighlightSettings('desktop-high');

describe('highlight appearance (T60/V29)', () => {
  it('maps a DISTINCT colour per interactable kind', () => {
    const kinds: TargetKind[] = ['door', 'container', 'corpse', 'window', 'structure'];
    const keys = kinds.map((k) => {
      const c = highlightColorFor(k, settings);
      return `${c.r},${c.g},${c.b}`;
    });
    expect(new Set(keys).size).toBe(kinds.length); // every kind a different colour
    for (const k of kinds) {
      const c = highlightColorFor(k, settings);
      for (const ch of [c.r, c.g, c.b]) {
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(1);
      }
    }
  });

  it('pulses between the configured min and max over time', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 4; t += 0.02) {
      const v = highlightPulseIntensity(t, settings, false);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeCloseTo(settings.pulseMin, 1);
    expect(hi).toBeCloseTo(settings.pulseMax, 1);
  });

  it('holds a steady glow (no pulse) when damped for reduce-flashes / reduce-motion', () => {
    const a = highlightPulseIntensity(0.1, settings, true);
    const b = highlightPulseIntensity(2.7, settings, true);
    expect(a).toBe(settings.reducedIntensity);
    expect(b).toBe(settings.reducedIntensity);
  });
});
