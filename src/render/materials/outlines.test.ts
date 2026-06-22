// T32 / V20 / V29 — outline tier assignment by distance/threat + small-character readability.

import { describe, it, expect } from 'vitest';
import {
  assignOutlineTier,
  outlineWidthFor,
  isSelectedHighlight,
  resolveOutlineSettings,
  type OutlineInput,
} from './outlines';

const settings = resolveOutlineSettings('desktop-high');

const threatInput = (over: Partial<OutlineInput> = {}): OutlineInput => ({
  subject: 'threat', distanceMeters: 5, threat: 1, pixelHeight: 80, ...over,
});

describe('assignOutlineTier (T32/V20)', () => {
  it('gives the player the strongest silhouette regardless of distance', () => {
    expect(assignOutlineTier({ subject: 'player', distanceMeters: 0, threat: 0, pixelHeight: 100 }, settings)).toBe('playerStrong');
    expect(assignOutlineTier({ subject: 'player', distanceMeters: 500, threat: 0, pixelHeight: 2 }, settings)).toBe('playerStrong');
  });

  it('gives nearby readable threats a medium outline', () => {
    expect(assignOutlineTier(threatInput(), settings)).toBe('threatMedium');
  });

  it('drops distant threats to dark mass (few/no per-body outlines)', () => {
    const far = threatInput({ distanceMeters: settings.threatMaxDistanceMeters + 5 });
    expect(assignOutlineTier(far, settings)).toBe('darkMass');
  });

  it('drops threats below the readable pixel height to dark mass (evaluate at gameplay pixel height)', () => {
    const tiny = threatInput({ pixelHeight: settings.minReadablePixelHeight - 1 });
    expect(assignOutlineTier(tiny, settings)).toBe('darkMass');
  });

  it('keeps a thin outline on selectively highlighted distant members (V20 selective highlight)', () => {
    const farSelected = threatInput({ distanceMeters: settings.threatMaxDistanceMeters + 5, selectedHighlight: true });
    expect(assignOutlineTier(farSelected, settings)).toBe('threatMedium');
  });

  it('uses restrained tiers for architecture + clutter', () => {
    expect(assignOutlineTier({ subject: 'architecture', distanceMeters: 5, threat: 0, pixelHeight: 50 }, settings)).toBe('architecture');
    expect(assignOutlineTier({ subject: 'clutter', distanceMeters: 5, threat: 0, pixelHeight: 50 }, settings)).toBe('clutterMinimal');
  });

  it('rejects invalid input (V4)', () => {
    expect(() => assignOutlineTier(threatInput({ distanceMeters: -1 }), settings)).toThrow();
    expect(() => assignOutlineTier(threatInput({ threat: 2 }), settings)).toThrow();
  });
});

describe('outlineWidthFor (T32)', () => {
  it('orders widths player >= threat >= architecture >= clutter, and zero for mass/none', () => {
    expect(outlineWidthFor('playerStrong', settings)).toBeGreaterThanOrEqual(outlineWidthFor('threatMedium', settings));
    expect(outlineWidthFor('threatMedium', settings)).toBeGreaterThanOrEqual(outlineWidthFor('architecture', settings));
    expect(outlineWidthFor('architecture', settings)).toBeGreaterThanOrEqual(outlineWidthFor('clutterMinimal', settings));
    expect(outlineWidthFor('darkMass', settings)).toBe(0);
    expect(outlineWidthFor('none', settings)).toBe(0);
  });
});

describe('isSelectedHighlight (T32)', () => {
  it('is deterministic and selects roughly the configured fraction', () => {
    let count = 0;
    const n = 5000;
    for (let slot = 0; slot < n; slot++) if (isSelectedHighlight(slot, settings)) count++;
    const frac = count / n;
    expect(frac).toBeGreaterThan(0);
    expect(frac).toBeLessThan(settings.darkMassHighlightFraction * 3);
    // determinism
    expect(isSelectedHighlight(123, settings)).toBe(isSelectedHighlight(123, settings));
  });
});
