// T49 / T50 / T51 — UI-lane store contracts (node, no DOM):
//   • session pause flag + the pure loop-gate predicate + time-scale clamp (T49 / V12)
//   • input keymap rebind, reset, V11 persistence partition, key-label formatter (T50 / V29)
//   • settings actions update the store + guard the quality-tier override (T51 / V25 / V29)

import { describe, it, expect } from 'vitest';
import {
  createSessionStore,
  simStepDt,
  clampTimeScale,
  TIME_SCALE_MIN,
  TIME_SCALE_REALTIME,
} from './session';
import { createInputStore, formatKeyCode, INPUT_ACTIONS } from './input';
import { createSettingsStore } from './settings';
import { QUALITY_TIERS } from '../config/types';

describe('T49 — authoritative pause (V12)', () => {
  it('toggles the paused flag and clears it on resume', () => {
    const s = createSessionStore();
    expect(s.getState().paused).toBe(false);
    s.getState().togglePause();
    expect(s.getState().paused).toBe(true);
    s.getState().togglePause();
    expect(s.getState().paused).toBe(false);
    s.getState().setPaused(true);
    expect(s.getState().paused).toBe(true);
  });

  it('reset() returns to unpaused, real-time', () => {
    const s = createSessionStore();
    s.getState().setPaused(true);
    s.getState().setTimeScale(0.25);
    s.getState().reset();
    expect(s.getState().paused).toBe(false);
    expect(s.getState().timeScale).toBe(TIME_SCALE_REALTIME);
  });

  it('does NOT persist transient paused / timeScale (only identity + slot)', () => {
    const s = createSessionStore();
    const partial = s.persist.getOptions().partialize?.(s.getState()) as Record<string, unknown>;
    expect(Object.keys(partial).sort()).toEqual(['saveSlot', 'sessionId']);
    expect('paused' in partial).toBe(false);
    expect('timeScale' in partial).toBe(false);
  });
});

describe('T49 — loop-gate predicate simStepDt (V12)', () => {
  const dt = 0.016;
  it('returns 0 dt while paused (the sim HALTS, not just the UI)', () => {
    expect(simStepDt(dt, true, 1)).toBe(0);
    expect(simStepDt(dt, true, 0.5)).toBe(0);
  });
  it('returns the real frame dt at real-time', () => {
    expect(simStepDt(dt, false, 1)).toBeCloseTo(dt);
  });
  it('scales the frame dt by the single-player slowdown', () => {
    expect(simStepDt(dt, false, 0.5)).toBeCloseTo(dt * 0.5);
  });
  it('clamps an out-of-band time-scale before scaling', () => {
    expect(simStepDt(dt, false, 0)).toBeCloseTo(dt * TIME_SCALE_MIN);
    expect(simStepDt(dt, false, 9)).toBeCloseTo(dt); // max is real-time
  });
});

describe('T49 — clampTimeScale', () => {
  it('clamps into the supported band and rejects NaN', () => {
    expect(clampTimeScale(0.5)).toBe(0.5);
    expect(clampTimeScale(0)).toBe(TIME_SCALE_MIN);
    expect(clampTimeScale(5)).toBe(1);
    expect(() => clampTimeScale(Number.NaN)).toThrow();
  });

  it('setTimeScale stores the clamped value', () => {
    const s = createSessionStore();
    s.getState().setTimeScale(99);
    expect(s.getState().timeScale).toBe(1);
    s.getState().setTimeScale(0);
    expect(s.getState().timeScale).toBe(TIME_SCALE_MIN);
  });
});

describe('T50 — input keymap rebind (V29)', () => {
  it('rebinds a single action without disturbing the others', () => {
    const s = createInputStore();
    const before = s.getState().bindings.moveUp;
    s.getState().rebind('moveUp', 'ArrowUp');
    expect(s.getState().bindings.moveUp).toBe('ArrowUp');
    expect(s.getState().bindings.moveDown).toBe(createInputStore().getState().bindings.moveDown);
    expect(before).not.toBe('ArrowUp');
  });

  it('resetBindings restores defaults', () => {
    const s = createInputStore();
    s.getState().rebind('attack', 'KeyZ');
    s.getState().resetBindings();
    expect(s.getState().bindings.attack).toBe('Mouse0');
  });

  it('exposes a binding for every listed action', () => {
    const s = createInputStore();
    for (const a of INPUT_ACTIONS) {
      expect(typeof s.getState().bindings[a]).toBe('string');
    }
  });
});

describe('T50 — input persistence partition (V11)', () => {
  it('input store now persists, partitioned to bindings + sensitivities only', () => {
    const s = createInputStore();
    expect('persist' in s).toBe(true);
    const opts = s.persist.getOptions();
    expect(opts.name).toContain('input');
    const partial = opts.partialize?.(s.getState()) as Record<string, unknown>;
    expect(Object.keys(partial).sort()).toEqual([
      'bindings',
      'invertZoom',
      'pointerSensitivity',
      'zoomSensitivity',
    ]);
  });

  it('sensitivity setters update the store', () => {
    const s = createInputStore();
    s.getState().setPointerSensitivity(2.5);
    s.getState().setZoomSensitivity(3);
    s.getState().setInvertZoom(true);
    expect(s.getState().pointerSensitivity).toBe(2.5);
    expect(s.getState().zoomSensitivity).toBe(3);
    expect(s.getState().invertZoom).toBe(true);
  });
});

describe('T50 — formatKeyCode', () => {
  it('renders friendly labels for keys + mouse buttons', () => {
    expect(formatKeyCode('KeyW')).toBe('W');
    expect(formatKeyCode('Digit3')).toBe('3');
    expect(formatKeyCode('Mouse0')).toBe('LMB');
    expect(formatKeyCode('Mouse2')).toBe('RMB');
    expect(formatKeyCode('Escape')).toBe('Escape');
  });
});

describe('T51 — settings actions + tier-override guard (V25 / V29)', () => {
  it('accepts every known tier and null (auto)', () => {
    const s = createSettingsStore();
    for (const t of QUALITY_TIERS) {
      s.getState().setQualityTierOverride(t);
      expect(s.getState().qualityTierOverride).toBe(t);
    }
    s.getState().setQualityTierOverride(null);
    expect(s.getState().qualityTierOverride).toBeNull();
  });

  it('rejects an unknown tier (no silent fallback)', () => {
    const s = createSettingsStore();
    // @ts-expect-error — exercising the runtime guard with an invalid tier
    expect(() => s.getState().setQualityTierOverride('ultra')).toThrow();
  });

  it('clamps volume + accessibility sliders into [0,1]', () => {
    const s = createSettingsStore();
    s.getState().setMasterVolume(5);
    expect(s.getState().masterVolume).toBe(1);
    s.getState().setGoreIntensity(-2);
    expect(s.getState().goreIntensity).toBe(0);
  });
});
