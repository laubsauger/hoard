// Headless unit tests for the PURE event→sound mapping (no AudioContext — Web Audio is unavailable in
// node, by design the GameAudio boundary is never constructed here). Covers gunshot/voice gain scaling,
// the V28 group-bed level vs horde count, groan scheduling, distance pan/gain, master-volume scaling,
// onset diffing, and the voice cap.

import { describe, expect, it } from 'vitest';
import {
  type AudibleSound,
  type AudioOutTuning,
  admitVoice,
  baseGainFor,
  clamp,
  hordeBedGain,
  newOnsetIds,
  oneShotVoiceFor,
  panForWorldX,
  panGainFor,
  shouldGroan,
  voiceGain,
} from './audioMapping';

const T: AudioOutTuning = {
  masterCeiling: 0.85,
  gunshotGain: 0.7,
  gunshotNoiseDecaySeconds: 0.12,
  gunshotThumpFreqHz: 70,
  gunshotThumpDecaySeconds: 0.18,
  hordeBedGain: 0.32,
  hordeBedFullCount: 40,
  hordeBedBaseFreqHz: 55,
  hordeBedLfoHz: 0.2,
  hordeBedGlideSeconds: 0.6,
  groanGain: 0.4,
  groanRatePerSecond: 0.7,
  groanMinIntervalSeconds: 0.7,
  groanDecaySeconds: 0.8,
  impactGain: 0.55,
  glassGain: 0.5,
  alarmGain: 0.45,
  footstepGain: 0.18,
  panWidthMeters: 18,
  maxVoices: 12,
};

describe('clamp', () => {
  it('clamps within bounds and throws on non-finite', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(() => clamp(NaN, 0, 1)).toThrow();
  });
});

describe('panForWorldX', () => {
  it('is centered when the source sits on the player', () => {
    expect(panForWorldX(10, 10, T.panWidthMeters)).toBe(0);
  });
  it('pans right for +x, left for -x, clamped to [-1, 1]', () => {
    expect(panForWorldX(10 + 9, 10, T.panWidthMeters)).toBeCloseTo(0.5);
    expect(panForWorldX(10 - 9, 10, T.panWidthMeters)).toBeCloseTo(-0.5);
    expect(panForWorldX(10 + 1000, 10, T.panWidthMeters)).toBe(1);
    expect(panForWorldX(10 - 1000, 10, T.panWidthMeters)).toBe(-1);
  });
  it('rejects a non-positive width', () => {
    expect(() => panForWorldX(1, 0, 0)).toThrow();
  });
});

describe('voiceGain (master-volume scaling + ceiling)', () => {
  it('scales linearly with reaching intensity, base gain, and master volume', () => {
    expect(voiceGain(1, 0.5, 1, T.masterCeiling)).toBeCloseTo(0.5);
    expect(voiceGain(0.5, 0.5, 1, T.masterCeiling)).toBeCloseTo(0.25);
    expect(voiceGain(1, 0.5, 0.5, T.masterCeiling)).toBeCloseTo(0.25);
  });
  it('master volume 0 silences', () => {
    expect(voiceGain(1, 1, 0, T.masterCeiling)).toBe(0);
  });
  it('never exceeds the master ceiling (no clipping)', () => {
    expect(voiceGain(1, 1, 1, T.masterCeiling)).toBe(T.masterCeiling);
  });
});

describe('panGainFor', () => {
  it('combines distance pan with reach+master gain', () => {
    const s: AudibleSound = { id: 1, source: 'glass', x: 19, z: 0, reaching: 0.5 };
    const pg = panGainFor(s, 10, baseGainFor('glass', T), 1, T);
    expect(pg.pan).toBeCloseTo(0.5);
    expect(pg.gain).toBeCloseTo(0.5 * T.glassGain);
  });
});

describe('oneShotVoiceFor', () => {
  it('maps world classes and leaves gunfire/weather/fire/player to other paths', () => {
    expect(oneShotVoiceFor('glass')).toBe('glass');
    expect(oneShotVoiceFor('alarm')).toBe('alarm');
    expect(oneShotVoiceFor('impact')).toBe('impact');
    expect(oneShotVoiceFor('breach')).toBe('breach');
    expect(oneShotVoiceFor('footstep')).toBe('footstep');
    expect(oneShotVoiceFor('voice')).toBe('groan');
    expect(oneShotVoiceFor('gunfire')).toBeNull();
    expect(oneShotVoiceFor('weather')).toBeNull();
    expect(oneShotVoiceFor('fire')).toBeNull();
    expect(oneShotVoiceFor('player')).toBeNull();
  });
});

describe('hordeBedGain (V28 group bed)', () => {
  it('is silent with no horde', () => {
    expect(hordeBedGain(0, 1, T)).toBe(0);
  });
  it('scales linearly with nearby count up to the full-size cap', () => {
    const half = hordeBedGain(T.hordeBedFullCount / 2, 1, T);
    const full = hordeBedGain(T.hordeBedFullCount, 1, T);
    expect(half).toBeCloseTo(0.5 * T.hordeBedGain);
    expect(full).toBeCloseTo(T.hordeBedGain);
    expect(half).toBeLessThan(full);
  });
  it('saturates above the full count and respects master volume + ceiling', () => {
    expect(hordeBedGain(10_000, 1, T)).toBeCloseTo(T.hordeBedGain);
    expect(hordeBedGain(10_000, 0.5, T)).toBeCloseTo(T.hordeBedGain * 0.5);
    expect(hordeBedGain(10_000, 1, { ...T, hordeBedGain: 1 })).toBe(T.masterCeiling);
  });
  it('rejects a non-positive full count', () => {
    expect(() => hordeBedGain(5, 1, { ...T, hordeBedFullCount: 0 })).toThrow();
  });
});

describe('newOnsetIds (discrete onset diff)', () => {
  it('returns ids present now but not last frame', () => {
    expect(newOnsetIds(new Set([1, 2]), [2, 3, 4])).toEqual([3, 4]);
    expect(newOnsetIds(new Set(), [7])).toEqual([7]);
    expect(newOnsetIds(new Set([5]), [5])).toEqual([]);
  });
});

describe('admitVoice (hard voice cap)', () => {
  it('admits below the cap and refuses at/over it', () => {
    expect(admitVoice(0, 12)).toBe(true);
    expect(admitVoice(11, 12)).toBe(true);
    expect(admitVoice(12, 12)).toBe(false);
    expect(admitVoice(20, 12)).toBe(false);
  });
});

describe('shouldGroan (V28 occasional foreground voices)', () => {
  const base = { dtSeconds: 1, secondsSinceLast: 10, activeVoices: 0, tuning: T };
  it('never groans with an empty horde', () => {
    expect(shouldGroan({ ...base, hordeCount: 0, rng01: 0 })).toBe(false);
  });
  it('respects the minimum interval', () => {
    expect(shouldGroan({ ...base, hordeCount: 40, secondsSinceLast: 0, rng01: 0 })).toBe(false);
  });
  it('respects the voice cap', () => {
    expect(shouldGroan({ ...base, hordeCount: 40, activeVoices: T.maxVoices, rng01: 0 })).toBe(false);
  });
  it('fires when the random draw is under the horde-scaled rate, and not otherwise', () => {
    // Full horde, dt 1s → probability == groanRatePerSecond (0.7).
    expect(shouldGroan({ ...base, hordeCount: 40, rng01: 0.5 })).toBe(true);
    expect(shouldGroan({ ...base, hordeCount: 40, rng01: 0.9 })).toBe(false);
  });
  it('scales probability down with a smaller horde', () => {
    // Half horde → probability 0.35; rng 0.5 should now miss.
    expect(shouldGroan({ ...base, hordeCount: 20, rng01: 0.5 })).toBe(false);
    expect(shouldGroan({ ...base, hordeCount: 20, rng01: 0.3 })).toBe(true);
  });
});
