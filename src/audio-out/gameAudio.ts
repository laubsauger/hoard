// Procedural WebAudio OUTPUT boundary. The ONLY place in this lane that touches the Web Audio API —
// kept thin and free of decision logic (those live in ./audioMapping.ts and are unit-tested headless,
// since Web Audio does not exist in node). Everything is SYNTHESIZED (oscillators + noise buffers +
// gain envelopes); there are NO asset files. Autoplay policy: the AudioContext is created/resumed
// LAZILY on the first user gesture (resume()); until then this object is silent and never throws.
// V24 — pooled, hard-capped voices that disconnect on end (no per-event node leak); dispose() frees
// the context and all nodes. V28 — the horde is ONE drone bed plus a few occasional groans.

import { resolveDomain } from '@/config/registry';
import { audioConfig } from '@/config/domains/audio';
import type { QualityTier } from '@/config/types';
import {
  type AudibleSound,
  type AudioOutTuning,
  type OneShotVoice,
  baseGainFor,
  hordeBedGain,
  newOnsetIds,
  oneShotVoiceFor,
  panForWorldX,
  shouldGroan,
  voiceGain,
} from './audioMapping';

/** Resolve the `out*` output tuning from the typed audio config for a quality tier (V4). */
export function resolveAudioOutTuning(tier: QualityTier): AudioOutTuning {
  const a = resolveDomain(audioConfig, tier);
  return {
    masterCeiling: a.outMasterCeiling,
    gunshotGain: a.outGunshotGain,
    gunshotNoiseDecaySeconds: a.outGunshotNoiseDecaySeconds,
    gunshotThumpFreqHz: a.outGunshotThumpFreqHz,
    gunshotThumpDecaySeconds: a.outGunshotThumpDecaySeconds,
    hordeBedGain: a.outHordeBedGain,
    hordeBedFullCount: a.outHordeBedFullCount,
    hordeBedBaseFreqHz: a.outHordeBedBaseFreqHz,
    hordeBedLfoHz: a.outHordeBedLfoHz,
    hordeBedGlideSeconds: a.outHordeBedGlideSeconds,
    groanGain: a.outGroanGain,
    groanRatePerSecond: a.outGroanRatePerSecond,
    groanMinIntervalSeconds: a.outGroanMinIntervalSeconds,
    groanDecaySeconds: a.outGroanDecaySeconds,
    impactGain: a.outImpactGain,
    glassGain: a.outGlassGain,
    alarmGain: a.outAlarmGain,
    footstepGain: a.outFootstepGain,
    panWidthMeters: a.outPanWidthMeters,
    maxVoices: a.outMaxVoices,
  };
}

/** Per-frame inputs the viewport feeds the audio layer (read-only; never mutates sim state, V2). */
export interface AudioFrameInput {
  readonly playerX: number;
  /** Sound stimuli reaching the player this frame (class + position + attenuated level). */
  readonly audible: readonly AudibleSound[];
  /** Nearby embodied horde count → drives the group-bed level (V28). */
  readonly hordeCount: number;
  readonly dtSeconds: number;
}

type WindowWithAudio = typeof globalThis & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

/** The drone group-bed nodes, created once on resume(). */
interface BedNodes {
  readonly oscA: OscillatorNode;
  readonly oscB: OscillatorNode;
  readonly lfo: OscillatorNode;
  readonly lfoGain: GainNode;
  readonly lowpass: BiquadFilterNode;
  readonly gain: GainNode;
}

export class GameAudio {
  private readonly tuning: AudioOutTuning;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bed: BedNodes | null = null;
  private noise: AudioBuffer | null = null;

  private masterVolume = 1;
  private muted = false;

  /** Live one-shot voice count (pooled, hard-capped). The player gunshot is exempt from the cap. */
  private activeVoices = 0;
  /** Stimulus ids that were audible last frame → onset diff for discrete one-shots. */
  private prevIds: Set<number> = new Set();
  private secondsSinceGroan = Number.POSITIVE_INFINITY;

  constructor(tuning: AudioOutTuning) {
    this.tuning = tuning;
  }

  /** Live master volume from the settings store (0..1). Applied to all gains via the pure mapping. */
  setMasterVolume(v: number): void {
    this.masterVolume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  }

  /** Master mute — silences the whole mix at the master node without tearing anything down. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.01);
    }
  }

  /**
   * Lazily create + resume the AudioContext on the first user gesture (autoplay policy). Safe to call
   * repeatedly and from any listener; never throws if Web Audio is unavailable (stays silent).
   */
  resume(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const w = globalThis as WindowWithAudio;
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return; // no Web Audio (e.g. headless) — silent, no error.
    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : 1;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      this.noise = this.buildNoiseBuffer(ctx);
      this.bed = this.buildBed(ctx, master);
      void ctx.resume();
    } catch {
      this.ctx = null;
      this.master = null;
    }
  }

  /** Player gunshot — direct, crisp, exempt from the voice cap (player-action feedback priority). */
  gunshot(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const peak = voiceGain(1, this.tuning.gunshotGain, this.masterVolume, this.tuning.masterCeiling);
    if (peak <= 0) return;

    // Crack: short white-noise burst through a band, fast exponential decay.
    if (this.noise) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      bp.Q.value = 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(peak, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + this.tuning.gunshotNoiseDecaySeconds);
      src.connect(bp).connect(g).connect(master);
      this.startTransient(src, t, this.tuning.gunshotNoiseDecaySeconds, /* counted */ false);
    }

    // Thump: low sine that drops in pitch and decays.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(this.tuning.gunshotThumpFreqHz, t);
    osc.frequency.exponentialRampToValueAtTime(this.tuning.gunshotThumpFreqHz * 0.5, t + this.tuning.gunshotThumpDecaySeconds);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(peak * 0.8, t);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + this.tuning.gunshotThumpDecaySeconds);
    osc.connect(tg).connect(master);
    this.startTransient(osc, t, this.tuning.gunshotThumpDecaySeconds, false);
  }

  /** Advance the live audio: bed level, occasional groans, and discrete world one-shots (V2 read-only). */
  frame(input: AudioFrameInput): void {
    const ctx = this.ctx;
    const bed = this.bed;
    const master = this.master;
    if (!ctx || !bed || !master) {
      // Still track ids so the first audible frame after resume() does not re-fire a backlog of onsets.
      this.prevIds = new Set(input.audible.map((s) => s.id));
      return;
    }
    const t = ctx.currentTime;

    // GROUP BED: one drone, level scales with nearby horde count, glided to avoid pops (V28).
    const bedTarget = hordeBedGain(input.hordeCount, this.masterVolume, this.tuning);
    bed.gain.gain.setTargetAtTime(bedTarget, t, this.tuning.hordeBedGlideSeconds);

    // OCCASIONAL FOREGROUND GROANS — never one per zombie; gated + capped (V28).
    this.secondsSinceGroan += input.dtSeconds;
    if (
      shouldGroan({
        hordeCount: input.hordeCount,
        dtSeconds: input.dtSeconds,
        secondsSinceLast: this.secondsSinceGroan,
        rng01: Math.random(),
        activeVoices: this.activeVoices,
        tuning: this.tuning,
      })
    ) {
      this.playGroan((Math.random() * 2 - 1) * 0.4);
      this.secondsSinceGroan = 0;
    }

    // DISCRETE WORLD ONE-SHOTS: a stimulus newly reaching the player this frame fires once.
    const onsets = newOnsetIds(this.prevIds, input.audible.map((s) => s.id));
    if (onsets.length > 0) {
      const onsetSet = new Set(onsets);
      for (const s of input.audible) {
        if (!onsetSet.has(s.id)) continue;
        const voice = oneShotVoiceFor(s.source);
        if (!voice) continue;
        const gain = voiceGain(s.reaching, baseGainFor(voice, this.tuning), this.masterVolume, this.tuning.masterCeiling);
        if (gain <= 0) continue;
        const pan = panForWorldX(s.x, input.playerX, this.tuning.panWidthMeters);
        this.playOneShot(voice, gain, pan);
      }
    }
    this.prevIds = new Set(input.audible.map((s) => s.id));
  }

  /** Tear down the AudioContext + every node on unmount (V24). Idempotent. */
  dispose(): void {
    const ctx = this.ctx;
    if (this.bed) {
      try {
        this.bed.oscA.stop();
        this.bed.oscB.stop();
        this.bed.lfo.stop();
      } catch { /* already stopped */ }
    }
    this.bed = null;
    this.master = null;
    this.noise = null;
    this.ctx = null;
    this.activeVoices = 0;
    this.prevIds = new Set();
    if (ctx) void ctx.close().catch(() => { /* already closed */ });
  }

  // ---- synthesis helpers (boundary-only; no decisions) ----

  private buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 1);
    const buf = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  private buildBed(ctx: AudioContext, master: GainNode): BedNodes {
    const base = this.tuning.hordeBedBaseFreqHz;
    const oscA = ctx.createOscillator();
    oscA.type = 'sawtooth';
    oscA.frequency.value = base;
    const oscB = ctx.createOscillator();
    oscB.type = 'sine';
    oscB.frequency.value = base * 1.01; // slight detune → slow beating, an uneasy crowd hum.
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = base * 6;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    // Slow amplitude LFO → the drone "breathes".
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = this.tuning.hordeBedLfoHz;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.3;
    lfo.connect(lfoGain).connect(gain.gain);

    oscA.connect(lowpass);
    oscB.connect(lowpass);
    lowpass.connect(gain).connect(master);
    oscA.start();
    oscB.start();
    lfo.start();
    return { oscA, oscB, lfo, lfoGain, lowpass, gain };
  }

  private playOneShot(voice: OneShotVoice, gain: number, pan: number): void {
    switch (voice) {
      case 'glass': return this.playNoiseBurst(gain, pan, 'highpass', 3500, 0.18);
      case 'alarm': return this.playAlarm(gain, pan);
      case 'impact': return this.playNoiseBurst(gain, pan, 'lowpass', 600, 0.16);
      case 'breach': return this.playNoiseBurst(gain, pan, 'lowpass', 400, 0.22);
      case 'footstep': return this.playNoiseBurst(gain, pan, 'lowpass', 900, 0.07);
      case 'groan': return this.playGroan(pan, gain);
    }
  }

  /** Filtered noise burst (impacts/glass/footsteps). */
  private playNoiseBurst(gain: number, pan: number, filter: BiquadFilterType, freq: number, decay: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noise) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const flt = ctx.createBiquadFilter();
    flt.type = filter;
    flt.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(flt).connect(g).connect(this.panner(ctx, pan, master));
    this.startTransient(src, t, decay, true);
  }

  /** Two-tone alarm warble. */
  private playAlarm(gain: number, pan: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const dur = 0.4;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(660, t + dur / 2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain * 0.7, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.panner(ctx, pan, master));
    this.startTransient(osc, t, dur, true);
  }

  /** A low, vibrato'd groan — a single FOREGROUND voice over the bed (V28). */
  private playGroan(pan: number, gainOverride?: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const dur = this.tuning.groanDecaySeconds;
    const peak = gainOverride ?? voiceGain(1, this.tuning.groanGain, this.masterVolume, this.tuning.masterCeiling);
    if (peak <= 0) return;
    const base = 90 + Math.random() * 50;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.linearRampToValueAtTime(base * 0.7, t + dur);
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 500;
    // Pitch vibrato.
    const vib = ctx.createOscillator();
    vib.type = 'sine';
    vib.frequency.value = 5;
    const vibGain = ctx.createGain();
    vibGain.gain.value = 6;
    vib.connect(vibGain).connect(osc.frequency);
    vib.onended = () => { try { vib.disconnect(); } catch { /* already gone */ } };
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(lowpass).connect(g).connect(this.panner(ctx, pan, master));
    vib.start(t);
    vib.stop(t + dur);
    this.startTransient(osc, t, dur, true);
  }

  private panner(ctx: AudioContext, pan: number, master: GainNode): StereoPannerNode {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(master);
    return p;
  }

  /**
   * Start a one-shot source and guarantee cleanup: stop after `dur`, disconnect every node on `ended`
   * (no per-event leak, V24). `counted` voices respect the pool cap and are NOT started when the pool is
   * full (the pure layer already gates groans/world voices; this is the boundary backstop).
   */
  private startTransient(src: OscillatorNode | AudioBufferSourceNode, startAt: number, dur: number, counted: boolean): void {
    if (counted) {
      if (this.activeVoices >= this.tuning.maxVoices) {
        try { src.disconnect(); } catch { /* not connected */ }
        return;
      }
      this.activeVoices++;
    }
    const tail = 0.05;
    src.onended = () => {
      try { src.disconnect(); } catch { /* already gone */ }
      if (counted) this.activeVoices = Math.max(0, this.activeVoices - 1);
    };
    try {
      src.start(startAt);
      src.stop(startAt + dur + tail);
    } catch {
      // start/stop can throw if the context died mid-frame; undo the count.
      if (counted) this.activeVoices = Math.max(0, this.activeVoices - 1);
    }
  }
}
