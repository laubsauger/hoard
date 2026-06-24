// T27 / V14 / V28 — audio simulation. A HEARD event also produces a Stimulus (intensity / frequency
// character via source / duration / obstruction / propagation) emitted into the INJECTED StimulusField
// — behavior only ever learns of the world through stimuli reaching its position (V14). A major event
// also registers a PERSISTENT disturbance (a long-lived, slowly-decaying stimulus) that keeps
// influencing migration after the transient sample ends (V28). Horde vocalization is layered as a
// GROUP BED plus a few selected foreground voices — never one stimulus per member (V28).

import { resolveDomain } from '@/config/registry';
import { audioConfig } from '@/config/domains/audio';
import type { QualityTier, ResolvedDomain } from '@/config/types';
import type { Stimulus, StimulusId, StimulusSource } from '@/game/core/contracts';
import type { StimulusField } from '@/game/stimulus';
import type { IdFactory } from '@/game/core/ids';

export type AudioSettings = ResolvedDomain<typeof audioConfig>;

const REFERENCE_TIER: QualityTier = 'desktop-high';

/** Heard sound classes. impacts/breaches, glass/alarms, gunfire, footsteps/movement, vocalization, weather/machinery. */
export type SoundClass = 'gunfire' | 'glass' | 'alarm' | 'impact' | 'breach' | 'footstep' | 'voice' | 'weather';

interface ClassProfile {
  readonly source: StimulusSource;
  readonly intensity: number;
  readonly radius: number;
}

export interface HearOptions {
  /** 0..1 obstruction between source and the open air (walls/closed doors) reduces intensity. */
  readonly obstruction?: number;
  /** Audible duration in ticks (drives decayPerTick). Omit -> config default. */
  readonly durationTicks?: number;
  /** Extra scale on intensity (e.g. a louder-than-usual impact). */
  readonly intensityScale?: number;
  /** P3 multi-floor: the nav level the sound was made on (0 = ground, default). Tags the stimulus so a hearer
   *  on another floor attenuates it (sound-through-floor, V4). Omit for single-floor — treated as level 0. */
  readonly level?: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class AudioSim {
  readonly settings: AudioSettings;
  private readonly ids: IdFactory;
  private readonly field: StimulusField;
  /** Active persistent disturbances (tick they expire). For migration/diagnostics queries. */
  private readonly disturbances: { readonly bornTick: number; readonly expiresTick: number }[] = [];

  constructor(deps: { ids: IdFactory; field: StimulusField; tier?: QualityTier }) {
    this.settings = resolveDomain(audioConfig, deps.tier ?? REFERENCE_TIER);
    this.ids = deps.ids;
    this.field = deps.field;
  }

  private profile(cls: SoundClass): ClassProfile {
    const s = this.settings;
    switch (cls) {
      case 'gunfire': return { source: 'gunfire', intensity: s.gunfireIntensity, radius: s.gunfireRadiusMeters };
      case 'glass': return { source: 'glass', intensity: s.glassIntensity, radius: s.glassRadiusMeters };
      case 'alarm': return { source: 'alarm', intensity: s.alarmIntensity, radius: s.alarmRadiusMeters };
      case 'impact': return { source: 'impact', intensity: s.impactIntensity, radius: s.impactRadiusMeters };
      case 'breach': return { source: 'breach', intensity: s.impactIntensity, radius: s.impactRadiusMeters };
      case 'footstep': return { source: 'footstep', intensity: s.footstepIntensity, radius: s.footstepRadiusMeters };
      case 'voice': return { source: 'voice', intensity: s.voiceIntensity, radius: s.voiceRadiusMeters };
      case 'weather': return { source: 'weather', intensity: s.weatherIntensity, radius: s.weatherRadiusMeters };
    }
  }

  /**
   * Register a heard event. Emits a transient Stimulus into the field and, if loud enough, also a
   * persistent disturbance. Returns the transient Stimulus.
   */
  hearEvent(cls: SoundClass, x: number, z: number, tick: number, opts: HearOptions = {}): Stimulus {
    const obstruction = opts.obstruction ?? 0;
    if (obstruction < 0 || obstruction > 1 || Number.isNaN(obstruction)) {
      throw new Error(`obstruction must be in [0,1], got ${obstruction}`);
    }
    const scale = opts.intensityScale ?? 1;
    if (scale < 0 || Number.isNaN(scale)) throw new Error(`intensityScale must be >= 0, got ${scale}`);
    const durationTicks = opts.durationTicks ?? this.settings.defaultDurationTicks;
    if (!Number.isInteger(durationTicks) || durationTicks <= 0) {
      throw new Error(`durationTicks must be a positive integer, got ${durationTicks}`);
    }

    const p = this.profile(cls);
    const intensity = clamp01(p.intensity * scale * (1 - obstruction));
    // decay is set so the sample fully fades after durationTicks (from its un-obstructed loudness).
    const decayPerTick = p.intensity / durationTicks;

    const stim: Stimulus = {
      id: this.ids.next<StimulusId>('stimulus'),
      kind: 'sound',
      source: p.source,
      x,
      z,
      intensity,
      radius: p.radius,
      bornTick: tick,
      decayPerTick,
      ...(opts.level !== undefined ? { level: opts.level } : {}),
    };
    if (intensity > 0) this.field.emit(stim, tick);

    // major event -> persistent disturbance keeps influencing migration after the sample ends (V28).
    if (intensity >= this.settings.majorEventThreshold) {
      this.registerDisturbance(p, intensity, x, z, tick, opts.level);
    }
    return stim;
  }

  private registerDisturbance(p: ClassProfile, intensity: number, x: number, z: number, tick: number, level?: number): void {
    const linger = this.settings.disturbanceLingerTicks;
    const stim: Stimulus = {
      id: this.ids.next<StimulusId>('stimulus'),
      kind: 'sound',
      source: p.source,
      x,
      z,
      intensity,
      // a lingering disturbance reaches further as it persists.
      radius: p.radius,
      bornTick: tick,
      decayPerTick: intensity / linger,
      ...(level !== undefined ? { level } : {}),
    };
    this.field.emit(stim, tick);
    this.disturbances.push({ bornTick: tick, expiresTick: tick + linger });
  }

  /** Number of persistent disturbances still influencing migration at `tick`. */
  activeDisturbances(tick: number): number {
    return this.disturbances.filter((d) => d.expiresTick > tick).length;
  }

  /**
   * Horde vocalization: a GROUP BED for the whole cluster plus a few foreground voices. Never emits
   * one stimulus per member (V28) — for a group at/above the bed threshold the count is capped at
   * 1 bed + hordeForegroundVoices, regardless of how large the horde is.
   */
  vocalize(groupSize: number, x: number, z: number, tick: number): Stimulus[] {
    if (!Number.isInteger(groupSize) || groupSize <= 0) throw new Error(`groupSize must be a positive integer, got ${groupSize}`);
    const s = this.settings;
    const out: Stimulus[] = [];
    if (groupSize < s.hordeBedThreshold) {
      // small group: a voice per member is acceptable.
      for (let i = 0; i < groupSize; i++) out.push(this.emitVoice(x, z, tick, 1));
      return out;
    }
    // group bed: one louder stimulus representing the whole cluster's vocal mass.
    const bedScale = Math.min(2, 1 + Math.log10(groupSize));
    out.push(this.emitVoice(x, z, tick, bedScale));
    // a few selected foreground voices.
    const voices = Math.min(s.hordeForegroundVoices, groupSize);
    for (let i = 0; i < voices; i++) out.push(this.emitVoice(x, z, tick, 1));
    return out;
  }

  private emitVoice(x: number, z: number, tick: number, scale: number): Stimulus {
    const s = this.settings;
    const stim: Stimulus = {
      id: this.ids.next<StimulusId>('stimulus'),
      kind: 'sound',
      source: 'voice',
      x,
      z,
      intensity: clamp01(s.voiceIntensity * scale),
      radius: s.voiceRadiusMeters * scale,
      bornTick: tick,
      decayPerTick: s.voiceIntensity / s.defaultDurationTicks,
    };
    this.field.emit(stim, tick);
    return stim;
  }
}
