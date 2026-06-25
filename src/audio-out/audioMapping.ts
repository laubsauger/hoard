// Procedural audio-output lane — PURE event→sound mapping. NO AudioContext, NO Web Audio nodes:
// every decision here is deterministic and headless-testable (the actual node wiring lives behind the
// thin GameAudio boundary in ./gameAudio.ts, which tests never construct). The game is otherwise silent;
// this layer turns the existing stimulus/event stream into synth directives. V28 — the horde is a single
// GROUP BED whose level scales with nearby count plus a FEW occasional foreground groans, never one
// voice per zombie. V4 — all tunables come from typed config (AudioOutTuning), no magic numbers here.

import type { StimulusSource } from '@/game/core/contracts';

/** A pooled, fire-and-forget synth voice triggered by a single audible world event. */
export type OneShotVoice = 'glass' | 'alarm' | 'impact' | 'breach' | 'footstep' | 'groan';

/**
 * Typed output tuning — the `out*` slice of the resolved audio config (V4). Pure functions take this
 * (not the registry) so tests construct a tiny literal instead of a full resolved domain.
 */
export interface AudioOutTuning {
  readonly masterCeiling: number;
  readonly gunshotGain: number;
  /** Extra gain scale on the INDOOR gunshot sample (the room clip read too loud); 1 = no change. */
  readonly gunshotIndoorScale: number;
  /** Extra gain scale on the OUTDOOR gunshot sample (pistol/SMG); 1 = no change. */
  readonly gunshotOutdoorScale: number;
  readonly gunshotNoiseDecaySeconds: number;
  readonly gunshotThumpFreqHz: number;
  readonly gunshotThumpDecaySeconds: number;
  readonly hordeBedGain: number;
  readonly hordeBedFullCount: number;
  readonly hordeBedBaseFreqHz: number;
  readonly hordeBedLfoHz: number;
  readonly hordeBedGlideSeconds: number;
  readonly groanGain: number;
  readonly groanRatePerSecond: number;
  readonly groanMinIntervalSeconds: number;
  readonly groanDecaySeconds: number;
  readonly impactGain: number;
  readonly glassGain: number;
  readonly alarmGain: number;
  readonly footstepGain: number;
  readonly panWidthMeters: number;
  readonly maxVoices: number;
  // ---- music bed (MUSIC bus) ----
  readonly musicBedGain: number;
  readonly musicMinLevel: number;
  readonly musicBaseFreqHz: number;
  readonly musicDetuneCents: number;
  readonly musicFilterBaseHz: number;
  readonly musicFilterRangeHz: number;
  readonly musicLfoHz: number;
  readonly musicLfoDepthHz: number;
  readonly musicTensionFullCount: number;
  readonly musicGlideSeconds: number;
}

/** A sound stimulus currently REACHING the player this frame (class + position + attenuated level). */
export interface AudibleSound {
  readonly id: number;
  readonly source: StimulusSource;
  readonly x: number;
  readonly z: number;
  /** Attenuated intensity actually reaching the player, 0..1 (already distance/time-faded by the field). */
  readonly reaching: number;
}

/** Computed pan + gain for one spatialized voice. */
export interface PanGain {
  /** -1 (full left) .. +1 (full right). */
  readonly pan: number;
  /** Final clamped gain, 0..masterCeiling. */
  readonly gain: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) throw new Error(`expected finite number, got ${v}`);
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Stereo pan from a source's world-x relative to the player (simple linear law, clamped to [-1, 1]). */
export function panForWorldX(sourceX: number, playerX: number, panWidthMeters: number): number {
  if (!(panWidthMeters > 0)) throw new Error(`panWidthMeters must be > 0, got ${panWidthMeters}`);
  return clamp((sourceX - playerX) / panWidthMeters, -1, 1);
}

/**
 * Final voice gain: the reaching intensity (already distance-faded) times the class base gain times the
 * live master volume, hard-clamped to the master ceiling so the mix can never clip.
 */
export function voiceGain(reaching: number, baseGain: number, masterVolume: number, masterCeiling: number): number {
  return clamp(clamp01(reaching) * baseGain * clamp01(masterVolume), 0, masterCeiling);
}

/**
 * Effective gain of a single bus in the master→{sfx, music} routing: the live master volume times the
 * bus volume, both clamped to 0..1. Setting EITHER to 0 mutes that bus (and only that bus, since the
 * other bus reads its own pair). This is the headless-testable contract for the node graph in GameAudio
 * (master GainNode in series with each bus GainNode → effective = master × bus).
 */
export function busGain(masterVolume: number, busVolume: number): number {
  return clamp01(masterVolume) * clamp01(busVolume);
}

/** Combined pan+gain for an audible world sound. */
export function panGainFor(sound: AudibleSound, playerX: number, baseGain: number, masterVolume: number, t: AudioOutTuning): PanGain {
  return {
    pan: panForWorldX(sound.x, playerX, t.panWidthMeters),
    gain: voiceGain(sound.reaching, baseGain, masterVolume, t.masterCeiling),
  };
}

/**
 * Map a stimulus source class to a one-shot voice, or null when this lane does not one-shot it:
 * `gunfire` is driven directly from the player-fire path (avoids a double trigger); `weather` is a bed,
 * not yet voiced; `fire`/`player` produce no sound here.
 */
export function oneShotVoiceFor(source: StimulusSource): OneShotVoice | null {
  switch (source) {
    case 'glass': return 'glass';
    case 'alarm': return 'alarm';
    case 'impact': return 'impact';
    case 'breach': return 'breach';
    case 'footstep': return 'footstep';
    case 'voice': return 'groan';
    case 'gunfire': return null;
    case 'fire': return null;
    case 'player': return null;
    case 'weather': return null;
    default: return null;
  }
}

/** Per-class base gain (before reach + master scaling). */
export function baseGainFor(voice: OneShotVoice, t: AudioOutTuning): number {
  switch (voice) {
    case 'glass': return t.glassGain;
    case 'alarm': return t.alarmGain;
    case 'impact': return t.impactGain;
    case 'breach': return t.impactGain;
    case 'footstep': return t.footstepGain;
    case 'groan': return t.groanGain;
  }
}

/**
 * GROUP-BED gain (V28): one drone whose level scales LINEARLY with nearby horde count up to a full-size
 * cap, times master volume, clamped to the ceiling. Zero zombies → silent bed.
 */
export function hordeBedGain(hordeCount: number, masterVolume: number, t: AudioOutTuning): number {
  if (!(t.hordeBedFullCount > 0)) throw new Error(`hordeBedFullCount must be > 0, got ${t.hordeBedFullCount}`);
  if (hordeCount <= 0) return 0;
  const level = clamp01(hordeCount / t.hordeBedFullCount);
  return clamp(level * t.hordeBedGain * clamp01(masterVolume), 0, t.masterCeiling);
}

/**
 * MUSIC tension (0..1): rises LINEARLY with the nearby horde count up to a full-tension cap, clamped.
 * 0 when alone → 1 when surrounded. Drives the music bed level + filter so it darkens/densifies as the
 * horde closes in. Pure + clamped (negative or huge counts are bounded, never NaN).
 */
export function musicTension(hordeCount: number, t: AudioOutTuning): number {
  if (!(t.musicTensionFullCount > 0)) throw new Error(`musicTensionFullCount must be > 0, got ${t.musicTensionFullCount}`);
  return clamp01(Math.max(0, hordeCount) / t.musicTensionFullCount);
}

/**
 * MUSIC bed gain (pre bus scaling): a calm floor (`musicMinLevel`) lerped up to full with tension, times
 * the bed gain, clamped to the master ceiling. The MUSIC bus then applies master × music on top, so this
 * is purely the tension-shaped level. Always > 0 (the bed is ever-present) unless `musicBedGain` is 0.
 */
export function musicBedGain(hordeCount: number, t: AudioOutTuning): number {
  const level = t.musicMinLevel + (1 - t.musicMinLevel) * musicTension(hordeCount, t);
  return clamp(clamp01(level) * t.musicBedGain, 0, t.masterCeiling);
}

/** MUSIC bed lowpass cutoff (Hz): the base cutoff opens by the full range as tension goes 0→1. */
export function musicFilterHz(hordeCount: number, t: AudioOutTuning): number {
  return t.musicFilterBaseHz + musicTension(hordeCount, t) * t.musicFilterRangeHz;
}

/** New stimulus ids present this frame but not last frame → discrete onsets to one-shot. */
export function newOnsetIds(prev: ReadonlySet<number>, current: Iterable<number>): number[] {
  const out: number[] = [];
  for (const id of current) if (!prev.has(id)) out.push(id);
  return out;
}

/** Whether a new pooled voice may start (hard cap; the player gunshot bypasses this). */
export function admitVoice(activeVoices: number, maxVoices: number): boolean {
  return activeVoices < maxVoices;
}

export interface GroanDecision {
  readonly hordeCount: number;
  readonly dtSeconds: number;
  readonly secondsSinceLast: number;
  /** Uniform random 0..1 for this frame's Bernoulli trial. */
  readonly rng01: number;
  readonly activeVoices: number;
  readonly tuning: AudioOutTuning;
}

/**
 * Decide whether to emit ONE occasional foreground groan this frame (V28): gated by a non-empty horde,
 * the voice cap, and a minimum spacing, then a Bernoulli trial whose probability scales with horde
 * fraction and the frame dt (a per-second rate). Pure + deterministic in `rng01`.
 */
export function shouldGroan(d: GroanDecision): boolean {
  const t = d.tuning;
  if (d.hordeCount <= 0) return false;
  if (!admitVoice(d.activeVoices, t.maxVoices)) return false;
  if (d.secondsSinceLast < t.groanMinIntervalSeconds) return false;
  const fraction = clamp01(d.hordeCount / t.hordeBedFullCount);
  const p = clamp01(t.groanRatePerSecond * fraction * Math.max(0, d.dtSeconds));
  return d.rng01 < p;
}
