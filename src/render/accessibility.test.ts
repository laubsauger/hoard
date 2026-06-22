// T40 / V29 — accessibility values propagate END-TO-END into the render lane's parameters: gore intensity
// gates the gore system, the feedback drives postfx damageFeedback (shake/flash/motion), and outline
// strength scales the selective-outline widths.

import { describe, it, expect } from 'vitest';
import { resolveRenderAccessibility, scaleOutlineSettings } from './accessibility';
import { damageFeedback } from './effects/postfx';
import { resolveOutlineSettings, assignOutlineTier, outlineWidthFor } from './materials/outlines';
import { GoreSystem, resolveGoreSettings } from './effects/gore';
import type { VisualEvent } from '../game/core/contracts/events';

const TIER = 'desktop-high' as const;

describe('accessibility -> render params (V29)', () => {
  it('maps settings onto the render-accessibility object (clamped)', () => {
    const a = resolveRenderAccessibility({
      goreIntensity: 0.5,
      outlineStrength: 0.25,
      targetHighlightStrength: 1,
      cameraShakeScale: 0,
      reduceFlashes: true,
      motionReduction: true,
    });
    expect(a.goreIntensity).toBe(0.5);
    expect(a.outlineStrength).toBe(0.25);
    expect(a.feedback.shakeScale).toBe(0);
    expect(a.feedback.reduceFlashes).toBe(true);
    expect(a.feedback.reduceMotion).toBe(true);
  });

  it('feeds postfx damageFeedback so shake/flash/motion respect the settings', () => {
    const full = resolveRenderAccessibility({ goreIntensity: 1, outlineStrength: 1, targetHighlightStrength: 1, cameraShakeScale: 1, reduceFlashes: false, motionReduction: false });
    const reduced = resolveRenderAccessibility({ goreIntensity: 1, outlineStrength: 1, targetHighlightStrength: 1, cameraShakeScale: 0, reduceFlashes: true, motionReduction: true });

    const fFull = damageFeedback(1, full.feedback, TIER);
    const fReduced = damageFeedback(1, reduced.feedback, TIER);
    expect(fReduced.shake).toBe(0); // shakeScale 0
    expect(fReduced.chromatic).toBe(0); // reduceFlashes
    expect(fReduced.blur).toBe(0); // reduceMotion
    expect(fFull.shake).toBeGreaterThan(0);
  });

  it('gore-intensity 0 suppresses gore entirely (V29)', () => {
    const gore = new GoreSystem(resolveGoreSettings(TIER));
    const hit: VisualEvent = { kind: 'hitReaction', id: 0 as never, target: 0 as never, region: 'torsoUpper', dirX: 1, dirZ: 0, energy: 1 };
    expect(gore.ingest(hit, 1, 0)).toBeNull(); // suppressed
    expect(gore.ingest(hit, 1, 1)).not.toBeNull(); // full
  });

  it('outline-strength 0 collapses every per-body outline width to 0; full keeps the hierarchy', () => {
    const base = resolveOutlineSettings(TIER);
    const off = scaleOutlineSettings(base, 0);
    const on = scaleOutlineSettings(base, 1);

    const nearThreat = { subject: 'threat' as const, distanceMeters: 2, threat: 1, pixelHeight: 200 };
    const tierNear = assignOutlineTier(nearThreat, base); // threatMedium (readable + near)
    expect(outlineWidthFor(tierNear, off)).toBe(0);
    expect(outlineWidthFor(tierNear, on)).toBeGreaterThan(0);
    // player rim also scales
    expect(off.rimStrength).toBe(0);
    expect(on.rimStrength).toBe(base.rimStrength);
  });
});
