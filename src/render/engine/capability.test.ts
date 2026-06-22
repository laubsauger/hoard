// T5 / V25 — capability tier mapping from mock adapter limits + safe user-override clamp.

import { describe, it, expect } from 'vitest';
import { detectQualityTier, applyTierOverride, CapabilityError, type AdapterLimits } from './capability';

const HIGH: AdapterLimits = {
  maxTextureDimension2D: 16384,
  maxBufferSize: 2 * 1024 * 1024 * 1024,
  maxComputeWorkgroupStorageSize: 32768,
};
const MEDIUM: AdapterLimits = {
  maxTextureDimension2D: 8192,
  maxBufferSize: 700 * 1024 * 1024,
  maxComputeWorkgroupStorageSize: 32768,
};
const MOBILE: AdapterLimits = {
  maxTextureDimension2D: 4096,
  maxBufferSize: 150 * 1024 * 1024,
  maxComputeWorkgroupStorageSize: 16384,
};

describe('detectQualityTier (V25)', () => {
  it('maps strong limits to desktop-high', () => {
    expect(detectQualityTier(HIGH)).toBe('desktop-high');
  });

  it('maps mid limits to desktop-medium', () => {
    expect(detectQualityTier(MEDIUM)).toBe('desktop-medium');
  });

  it('maps floor limits to mobile-webgpu', () => {
    expect(detectQualityTier(MOBILE)).toBe('mobile-webgpu');
  });

  it('throws (no invented fallback) when below the mobile floor', () => {
    expect(() =>
      detectQualityTier({ maxTextureDimension2D: 1024, maxBufferSize: 1, maxComputeWorkgroupStorageSize: 1 }),
    ).toThrow(CapabilityError);
  });

  it('rejects malformed limits instead of guessing', () => {
    expect(() =>
      detectQualityTier({ maxTextureDimension2D: NaN, maxBufferSize: 1, maxComputeWorkgroupStorageSize: 1 }),
    ).toThrow(CapabilityError);
  });
});

describe('applyTierOverride (V25 safe-limit guard)', () => {
  it('honors a less-demanding override', () => {
    expect(applyTierOverride('desktop-high', 'desktop-compat')).toBe('desktop-compat');
  });

  it('clamps a more-demanding override down to detected capability', () => {
    expect(applyTierOverride('desktop-medium', 'desktop-high')).toBe('desktop-medium');
  });

  it('passes through an equal override', () => {
    expect(applyTierOverride('mobile-webgpu', 'mobile-webgpu')).toBe('mobile-webgpu');
  });
});
