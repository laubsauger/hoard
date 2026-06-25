// Procedural WebAudio OUTPUT boundary. The ONLY place in this lane that touches the Web Audio API —
// kept thin and free of decision logic (those live in ./audioMapping.ts and are unit-tested headless,
// since Web Audio does not exist in node). Everything is SYNTHESIZED (oscillators + noise buffers +
// gain envelopes); there are NO asset files. Autoplay policy: the AudioContext is created/resumed
// LAZILY on the first user gesture (resume()); until then this object is silent and never throws.
// V24 — pooled, hard-capped voices that disconnect on end (no per-event node leak); dispose() frees
// the context and all nodes. V28 — the horde is ONE drone bed plus a few occasional groans.
// Routing: master GainNode → {SFX bus, MUSIC bus}. ALL one-shots + the horde bed/groans are SFX (route
// through the SFX bus, effective gain = master × sfx); the ever-present procedural music drone routes
// through the MUSIC bus (effective gain = master × music). Volume 0 on a bus mutes only that bus.

import { resolveDomain } from '@/config/registry';
import { audioConfig } from '@/config/domains/audio';
import type { QualityTier } from '@/config/types';
import {
  type AudibleSound,
  type AudioOutTuning,
  type OneShotVoice,
  baseGainFor,
  clamp01,
  hordeBedGain,
  musicBedGain,
  musicFilterHz,
  newOnsetIds,
  oneShotVoiceFor,
  panForWorldX,
  shouldGroan,
  voiceGain,
} from './audioMapping';
import { SampleBank, type SfxBankName } from './sampleBank';

/** Resolve the `out*` output tuning from the typed audio config for a quality tier (V4). */
export function resolveAudioOutTuning(tier: QualityTier): AudioOutTuning {
  const a = resolveDomain(audioConfig, tier);
  return {
    masterCeiling: a.outMasterCeiling,
    gunshotGain: a.outGunshotGain,
    gunshotIndoorScale: a.outGunshotIndoorScale,
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
    musicBedGain: a.outMusicBedGain,
    musicMinLevel: a.outMusicMinLevel,
    musicBaseFreqHz: a.outMusicBaseFreqHz,
    musicDetuneCents: a.outMusicDetuneCents,
    musicFilterBaseHz: a.outMusicFilterBaseHz,
    musicFilterRangeHz: a.outMusicFilterRangeHz,
    musicLfoHz: a.outMusicLfoHz,
    musicLfoDepthHz: a.outMusicLfoDepthHz,
    musicTensionFullCount: a.outMusicTensionFullCount,
    musicGlideSeconds: a.outMusicGlideSeconds,
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

/** The procedural MUSIC drone nodes (one bed, no per-frame nodes), created once on resume(). */
interface MusicNodes {
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
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private bed: BedNodes | null = null;
  private music: MusicNodes | null = null;
  /** Authored sampled-SFX bank (gunshots/footsteps/grunts/doors/…); decoded async after the ctx resumes. */
  private readonly samples = new SampleBank();

  // Live bus volumes (0..1) from the settings store. The node graph applies master × bus; the pure
  // shaping functions take volume = 1 (the bus nodes carry the master/sfx/music scaling), not master.
  private masterVolume = 1;
  private sfxVolume = 1;
  private musicVolume = 1;

  /** Live one-shot voice count (pooled, hard-capped). The player gunshot is exempt from the cap. */
  private activeVoices = 0;
  /** Stimulus ids that were audible last frame → onset diff for discrete one-shots. */
  private prevIds: Set<number> = new Set();
  private secondsSinceGroan = Number.POSITIVE_INFINITY;

  constructor(tuning: AudioOutTuning) {
    this.tuning = tuning;
  }

  /**
   * Live volumes from the settings store (0..1 each). Routes as master → {sfx, music}: the master node
   * carries master, each bus node carries its own volume, so the effective per-bus gain is master × bus
   * and a 0 on one bus mutes ONLY that bus. Glided (setTargetAtTime) so dragging a slider never pops.
   */
  setVolumes(v: { readonly master: number; readonly sfx: number; readonly music: number }): void {
    this.masterVolume = clamp01(Number.isFinite(v.master) ? v.master : 0);
    this.sfxVolume = clamp01(Number.isFinite(v.sfx) ? v.sfx : 0);
    this.musicVolume = clamp01(Number.isFinite(v.music) ? v.music : 0);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const glide = 0.02;
    this.master?.gain.setTargetAtTime(this.masterVolume, t, glide);
    this.sfxBus?.gain.setTargetAtTime(this.sfxVolume, t, glide);
    this.musicBus?.gain.setTargetAtTime(this.musicVolume, t, glide);
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
      // master → {sfx bus, music bus}. Bus nodes carry the live per-bus volume; master carries master.
      const master = ctx.createGain();
      master.gain.value = this.masterVolume;
      master.connect(ctx.destination);
      const sfxBus = ctx.createGain();
      sfxBus.gain.value = this.sfxVolume;
      sfxBus.connect(master);
      const musicBus = ctx.createGain();
      musicBus.gain.value = this.musicVolume;
      musicBus.connect(master);
      this.ctx = ctx;
      this.master = master;
      this.sfxBus = sfxBus;
      this.musicBus = musicBus;
      void this.samples.load(ctx); // decode the authored sfx clips in the background (best-effort, never throws)
      // The procedural DRONE beds (horde + music) are GONE — they read as an ugly constant sine. Not built at
      // all (config gains were already 0; this removes the oscillators outright). One-shots/groans still play.
      this.bed = null;
      this.music = null;
      void ctx.resume();
    } catch {
      this.ctx = null;
      this.master = null;
      this.sfxBus = null;
      this.musicBus = null;
    }
  }

  /** Player gunshot — the authored weapon SAMPLE (no synthesized stand-in; if the clip hasn't decoded the shot is
   *  simply silent that frame, never a fake crack). The SHOTGUN uses its own fire+eject clip; pistol/rifle use the
   *  indoor/outdoor pistol sample, with the INDOOR variant toned down (it read too loud). `weapon` is the active
   *  weapon class (`runtime.currentWeaponId()`). */
  gunshot(indoor = false, weapon = 'pistol'): void {
    const peak = voiceGain(1, this.tuning.gunshotGain, 1, this.tuning.masterCeiling);
    if (peak <= 0) return;
    // EXEMPT from the voice cap (counted=false) — the player gunshot is priority feedback; otherwise rapid fire
    // (the clip is longer than the fire interval, so shots overlap) hit the cap and dropped every other.
    if (weapon === 'shotgun' && this.samples.has('shotgunFire')) {
      this.playSample('shotgunFire', peak, 0, 0.03, /* counted */ false);
      return;
    }
    const gain = indoor ? peak * this.tuning.gunshotIndoorScale : peak; // the room clip read too loud — tone it down
    this.playSample(indoor ? 'pistolIndoor' : 'pistolOutdoor', gain, 0, 0.03, /* counted */ false);
  }

  /** Player weapon RELOAD — the authored reload sample (magazine swap). */
  reload(): void {
    this.playSample('pistolReload', 0.8, 0, 0.02);
  }

  /** Advance the live audio: bed level, occasional groans, and discrete world one-shots (V2 read-only). */
  frame(input: AudioFrameInput): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus) {
      // Still track ids so the first audible frame after resume() does not re-fire a backlog of onsets.
      this.prevIds = new Set(input.audible.map((s) => s.id));
      return;
    }
    const t = ctx.currentTime;

    // Drone beds are no longer built (the constant-sine annoyance). If they ever are again, drive them here;
    // their absence does NOT gate the one-shots/groans below (those are the live, transient audio).
    const bed = this.bed;
    const music = this.music;
    if (bed) bed.gain.gain.setTargetAtTime(hordeBedGain(input.hordeCount, 1, this.tuning), t, this.tuning.hordeBedGlideSeconds);
    if (music) {
      music.gain.gain.setTargetAtTime(musicBedGain(input.hordeCount, this.tuning), t, this.tuning.musicGlideSeconds);
      music.lowpass.frequency.setTargetAtTime(musicFilterHz(input.hordeCount, this.tuning), t, this.tuning.musicGlideSeconds);
    }

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
      // Sampled zombie moan (was a synth groan) — silent if the clips haven't decoded, never a fake.
      this.playSample('zombie', voiceGain(1, this.tuning.groanGain, 1, this.tuning.masterCeiling), (Math.random() * 2 - 1) * 0.4, 0.08);
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
        const gain = voiceGain(s.reaching, baseGainFor(voice, this.tuning), 1, this.tuning.masterCeiling);
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
    if (this.music) {
      try {
        this.music.oscA.stop();
        this.music.oscB.stop();
        this.music.lfo.stop();
      } catch { /* already stopped */ }
    }
    this.bed = null;
    this.music = null;
    this.master = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.ctx = null;
    this.activeVoices = 0;
    this.prevIds = new Set();
    if (ctx) void ctx.close().catch(() => { /* already closed */ });
  }

  // ---- world one-shots: AUTHORED SAMPLES ONLY (no synthesized stand-ins) ----

  /**
   * Map a world one-shot voice to its authored sample bank and play it. NO synthesized fallback: a voice with
   * no decoded clip (or no asset at all — impact/breach/alarm currently have none) is SILENT, never a made-up
   * synth noise played on top of / instead of a real sample (the explicit "samples or nothing" rule).
   */
  private playOneShot(voice: OneShotVoice, gain: number, pan: number): void {
    switch (voice) {
      case 'glass': this.playSample('windowBreak', gain, pan, 0.02); return;
      case 'groan': this.playSample('zombie', gain, pan, 0.08); return;
      case 'footstep': this.playSample('footstepConcrete', gain, pan, 0.1); return;
      // impact / breach / alarm: no authored asset yet → silent (no synth).
      case 'impact':
      case 'breach':
      case 'alarm':
        return;
    }
  }

  /**
   * Play a random VARIANT of a sampled bank through the SFX bus (panned, optional ± pitch jitter so repeats
   * don't sound identical). Returns false when the bank has not decoded / is absent — there is NO synth
   * fallback, so the caller simply makes no sound. Pooled + voice-capped via startTransient (V24).
   */
  private playSample(bank: SfxBankName, gain: number, pan: number, pitchVar = 0, counted = true): boolean {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus || gain <= 0) return false;
    const buf = this.samples.pick(bank);
    if (!buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const rate = pitchVar > 0 ? 1 + (Math.random() * 2 - 1) * pitchVar : 1;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.panner(ctx, pan, bus));
    this.startTransient(src, ctx.currentTime, buf.duration / rate, counted);
    return true;
  }

  /** Door OPEN — sampled, pitch-jittered (the door system fires this on a successful open). */
  doorOpen(pan = 0): void {
    this.playSample('doorOpen', 0.85, pan, 0.05);
  }

  /** Door CLOSE — sampled. */
  doorClose(pan = 0): void {
    this.playSample('doorClose', 0.85, pan, 0.05);
  }

  /** Player exertion / pain grunt — a random one of the separated male-grunt variants (T-audio). */
  grunt(): void {
    this.playSample('grunt', 0.8, 0, 0.06);
  }

  /** A loot container opening (cardboard box). */
  containerOpen(pan = 0): void {
    this.playSample('containerOpen', 0.8, pan, 0.04);
  }

  /** A player footstep on a TERRAIN surface — picks the matching sampled bank + pitch-jitters it. */
  footstep(terrain: 'concrete' | 'dirt' | 'grass' | 'wood', pan = 0): void {
    const bank: SfxBankName =
      terrain === 'concrete' ? 'footstepConcrete' : terrain === 'dirt' ? 'footstepDirt' : terrain === 'grass' ? 'footstepGrass' : 'footstepWood';
    this.playSample(bank, 0.6, pan, 0.1);
  }


  private panner(ctx: AudioContext, pan: number, dest: GainNode): StereoPannerNode {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(dest);
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
