// T5/T7/T9/T4 — verify the render/UI/input config domains self-register and validate (V4),
// and that capability thresholds + camera bands resolve as the tier machinery expects (V25/V21).

import { describe, it, expect } from 'vitest';
import { resolve } from '../config/spec';
import { validateAll, registeredDomains } from '../config/registry';
import { renderingConfig } from '../config/domains/rendering';
import { cameraConfig } from '../config/domains/camera';
import { uiConfig } from '../config/domains/UI';
import { inputConfig } from '../config/domains/input';

describe('render/UI/input config domains (V4)', () => {
  it('register without throwing and pass validateAll', () => {
    const domains = registeredDomains();
    expect(domains).toContain('rendering');
    expect(domains).toContain('camera');
    expect(domains).toContain('UI');
    expect(domains).toContain('input');
    expect(() => validateAll()).not.toThrow();
  });

  it('expresses capability thresholds as descending per-tier minimums (V25)', () => {
    const high = resolve(renderingConfig.minMaxTextureDimension2D, 'desktop-high');
    const medium = resolve(renderingConfig.minMaxTextureDimension2D, 'desktop-medium');
    const mobile = resolve(renderingConfig.minMaxTextureDimension2D, 'mobile-webgpu');
    expect(high).toBeGreaterThanOrEqual(medium);
    expect(medium).toBeGreaterThanOrEqual(mobile);
  });

  it('scales crowd instance capacity down on lower tiers (V22/V10)', () => {
    const high = resolve(renderingConfig.crowdInstanceCapacity, 'desktop-high');
    const mobile = resolve(renderingConfig.crowdInstanceCapacity, 'mobile-webgpu');
    expect(high).toBeGreaterThan(mobile);
  });

  it('keeps camera pitch within the V21 ~35-45 deg band and 90 deg rotation step', () => {
    expect(resolve(cameraConfig.pitchDegreesMin, 'desktop-high')).toBeGreaterThanOrEqual(35);
    expect(resolve(cameraConfig.pitchDegreesMax, 'desktop-high')).toBeLessThanOrEqual(45);
    expect(resolve(cameraConfig.rotationStepDegrees, 'desktop-high')).toBe(90);
  });

  it('provides positive throttle intervals + sensitivities (V11/V29)', () => {
    expect(resolve(uiConfig.playerSnapshotThrottleMs, 'desktop-high')).toBeGreaterThan(0);
    expect(resolve(inputConfig.zoomSensitivity, 'desktop-high')).toBeGreaterThan(0);
  });
});
