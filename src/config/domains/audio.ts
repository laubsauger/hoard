// Config domain: audio. Owned by lane S (T27). V28 — a heard event ALSO produces a stimulus
// (intensity/duration/source/obstruction/propagation). Coarse sector graph for long-range spread;
// doors/windows/breaches/floors/materials are attenuation links. Per-class base intensity + radius
// are typed content here; the AudioSim composes them into Stimulus records emitted into the field.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const audioConfig = registerDomain('audio', {
  // ---- per-class base loudness (intensity 0..1) ----
  gunfireIntensity: num({ owner: 'audio', unit: 'ratio', doc: 'Base intensity of a gunshot.', default: 1, min: 0, max: 1 }),
  glassIntensity: num({ owner: 'audio', unit: 'ratio', doc: 'Base intensity of breaking glass.', default: 0.7, min: 0, max: 1 }),
  alarmIntensity: num({ owner: 'audio', unit: 'ratio', doc: 'Base intensity of an alarm.', default: 0.9, min: 0, max: 1 }),
  impactIntensity: num({ owner: 'audio', unit: 'ratio', doc: 'Base intensity of an impact/breach hit.', default: 0.6, min: 0, max: 1 }),
  footstepIntensity: num({ owner: 'audio', unit: 'ratio', doc: 'Base intensity of footsteps/movement.', default: 0.2, min: 0, max: 1 }),
  voiceIntensity: num({ owner: 'audio', unit: 'ratio', doc: 'Base intensity of a single zombie vocalization.', default: 0.45, min: 0, max: 1 }),
  weatherIntensity: num({ owner: 'audio', unit: 'ratio', doc: 'Base intensity of weather/machinery ambience.', default: 0.3, min: 0, max: 1 }),

  // ---- per-class reach (radius m) ----
  gunfireRadiusMeters: num({ owner: 'audio', unit: 'meters', doc: 'Reach (m) of a gunshot.', default: 120, min: 1, max: 1000 }),
  glassRadiusMeters: num({ owner: 'audio', unit: 'meters', doc: 'Reach (m) of breaking glass.', default: 40, min: 1, max: 1000 }),
  alarmRadiusMeters: num({ owner: 'audio', unit: 'meters', doc: 'Reach (m) of an alarm.', default: 90, min: 1, max: 1000 }),
  impactRadiusMeters: num({ owner: 'audio', unit: 'meters', doc: 'Reach (m) of an impact/breach.', default: 35, min: 1, max: 1000 }),
  footstepRadiusMeters: num({ owner: 'audio', unit: 'meters', doc: 'Reach (m) of footsteps.', default: 10, min: 1, max: 1000 }),
  voiceRadiusMeters: num({ owner: 'audio', unit: 'meters', doc: 'Reach (m) of a vocalization.', default: 25, min: 1, max: 1000 }),
  weatherRadiusMeters: num({ owner: 'audio', unit: 'meters', doc: 'Reach (m) of weather/machinery.', default: 200, min: 1, max: 1000 }),

  // ---- stimulus shaping ----
  defaultDurationTicks: num({
    owner: 'audio', unit: 'ticks',
    doc: 'Default audible duration of a transient event in ticks (drives Stimulus decayPerTick).',
    default: 6, min: 1, max: 6000, integer: true,
  }),
  // ---- coarse sector sound graph (long-range spread) ----
  doorAttenuation: num({ owner: 'audio', unit: 'ratio', doc: 'Intensity fraction retained crossing a closed door link.', default: 0.35, min: 0, max: 1 }),
  windowAttenuation: num({ owner: 'audio', unit: 'ratio', doc: 'Intensity fraction retained crossing a window link.', default: 0.55, min: 0, max: 1 }),
  breachAttenuation: num({ owner: 'audio', unit: 'ratio', doc: 'Intensity fraction retained crossing a breach/open link.', default: 0.9, min: 0, max: 1 }),
  floorAttenuation: num({ owner: 'audio', unit: 'ratio', doc: 'Intensity fraction retained crossing a floor/ceiling link.', default: 0.4, min: 0, max: 1 }),
  wallAttenuation: num({ owner: 'audio', unit: 'ratio', doc: 'Intensity fraction retained through a solid wall link.', default: 0.15, min: 0, max: 1 }),
  minPropagatedIntensity: num({
    owner: 'audio', unit: 'ratio',
    doc: 'Sound below this propagated intensity stops spreading through the sector graph.',
    default: 0.05, min: 0.0001, max: 1,
  }),
  // ---- persistent disturbance (major event keeps influencing migration after the sample ends) ----
  majorEventThreshold: num({
    owner: 'audio', unit: 'ratio',
    doc: 'Stimulus intensity at/above which a persistent disturbance is also registered (V28).',
    default: 0.8, min: 0, max: 1,
  }),
  disturbanceLingerTicks: num({
    owner: 'audio', unit: 'ticks',
    doc: 'Ticks a persistent disturbance keeps influencing migration after its source sample ends.',
    default: 600, min: 1, max: 100000, integer: true,
  }),
  // ---- horde vocalization (group beds + selected foreground voices, NOT per-member, V28) ----
  hordeBedThreshold: num({
    owner: 'audio', unit: 'count',
    doc: 'Group size at/above which vocalization collapses to one group bed (no per-member voices).',
    default: 8, min: 1, max: 100000, integer: true,
  }),
  hordeForegroundVoices: num({
    owner: 'audio', unit: 'count',
    doc: 'Number of selected foreground voices layered over a group bed.',
    default: 3, min: 0, max: 64, integer: true,
  }),
  // ---- stimulus field capacity (max concurrent active stimuli before weakest-evicts, T38) ----
  stimulusFieldCapacity: num({
    owner: 'audio', unit: 'count',
    doc: 'Max simultaneously active stimuli in the shared StimulusField before the weakest is evicted.',
    default: 256, min: 16, max: 8192, integer: true,
  }),

  // ============================================================================
  // AUDIO OUTPUT (procedural WebAudio render layer — additive, owned by the audio-out lane).
  // The SIM fields above shape the perception STIMULUS model; the `out*` fields below shape the
  // actual SOUND a player HEARS. All synthesized (no asset files); driven by the event stream +
  // the stimulus field reaching the player + the live horde count. Hard-capped so it never clips
  // (V4 — no magic numbers; V28 — group bed + a few foreground groans, never one voice per zombie).
  // ============================================================================
  outMasterCeiling: num({
    owner: 'audio', unit: 'ratio',
    doc: 'Hard upper clamp applied to every resolved output gain so the mix can never clip.',
    default: 0.85, min: 0, max: 1,
  }),
  // ---- player gunshot (direct, fired from the player-fire path) ----
  outGunshotGain: num({ owner: 'audio', unit: 'ratio', doc: 'Peak gain of a player gunshot before master scaling.', default: 0.7, min: 0, max: 1 }),
  outGunshotNoiseDecaySeconds: num({ owner: 'audio', unit: 'seconds', doc: 'Exponential decay time of the gunshot noise crack.', default: 0.12, min: 0.01, max: 2 }),
  outGunshotThumpFreqHz: num({ owner: 'audio', unit: 'hz', doc: 'Base frequency of the gunshot low thump.', default: 70, min: 20, max: 400 }),
  outGunshotThumpDecaySeconds: num({ owner: 'audio', unit: 'seconds', doc: 'Exponential decay time of the gunshot low thump.', default: 0.18, min: 0.01, max: 2 }),
  // ---- zombie GROUP BED drone (one drone whose level scales with nearby horde count, V28) ----
  outHordeBedGain: num({ owner: 'audio', unit: 'ratio', doc: 'Gain of the horde drone bed at full horde size, before master scaling.', default: 0.32, min: 0, max: 1 }),
  outHordeBedFullCount: num({ owner: 'audio', unit: 'count', doc: 'Nearby horde size at which the group bed reaches full gain (linear ramp below).', default: 40, min: 1, max: 100000, integer: true }),
  outHordeBedBaseFreqHz: num({ owner: 'audio', unit: 'hz', doc: 'Base frequency of the low horde drone.', default: 55, min: 20, max: 400 }),
  outHordeBedLfoHz: num({ owner: 'audio', unit: 'hz', doc: 'Slow amplitude-modulation rate of the horde drone.', default: 0.2, min: 0.01, max: 8 }),
  outHordeBedGlideSeconds: num({ owner: 'audio', unit: 'seconds', doc: 'Time constant for the bed gain to glide toward its target level (no pops).', default: 0.6, min: 0.01, max: 10 }),
  // ---- occasional foreground groans (a FEW selected voices over the bed, never per-member, V28) ----
  outGroanGain: num({ owner: 'audio', unit: 'ratio', doc: 'Peak gain of a foreground groan before master scaling.', default: 0.4, min: 0, max: 1 }),
  outGroanRatePerSecond: num({ owner: 'audio', unit: 'ratio', doc: 'Groan trigger probability per second at full horde size (scaled by horde fraction).', default: 0.7, min: 0, max: 20 }),
  outGroanMinIntervalSeconds: num({ owner: 'audio', unit: 'seconds', doc: 'Minimum spacing between consecutive foreground groans.', default: 0.7, min: 0, max: 30 }),
  outGroanDecaySeconds: num({ owner: 'audio', unit: 'seconds', doc: 'Amplitude envelope length of a foreground groan.', default: 0.8, min: 0.05, max: 5 }),
  // ---- world one-shots (impacts / glass / alarms / footsteps) keyed off the reaching stimulus class ----
  outImpactGain: num({ owner: 'audio', unit: 'ratio', doc: 'Peak gain of an impact/breach one-shot before reach + master scaling.', default: 0.55, min: 0, max: 1 }),
  outGlassGain: num({ owner: 'audio', unit: 'ratio', doc: 'Peak gain of a breaking-glass one-shot before reach + master scaling.', default: 0.5, min: 0, max: 1 }),
  outAlarmGain: num({ owner: 'audio', unit: 'ratio', doc: 'Peak gain of an alarm one-shot before reach + master scaling.', default: 0.45, min: 0, max: 1 }),
  outFootstepGain: num({ owner: 'audio', unit: 'ratio', doc: 'Peak gain of a footstep one-shot before reach + master scaling.', default: 0.18, min: 0, max: 1 }),
  // ---- spatialization + voice budget ----
  outPanWidthMeters: num({ owner: 'audio', unit: 'meters', doc: 'World-x offset from the player mapped to full left/right stereo pan.', default: 18, min: 0.1, max: 1000 }),
  outMaxVoices: num({ owner: 'audio', unit: 'count', doc: 'Hard cap on concurrent pooled world/groan one-shot voices (player gunshot is exempt).', default: 12, min: 1, max: 128, integer: true }),
  // ---- procedural MUSIC bed (low, slow, evolving ambient/tension drone on the dedicated MUSIC bus) ----
  // One ever-present bed (a couple of detuned oscillators + a slow filter LFO); tension rises with the
  // nearby horde count — calmer when alone, denser/edgier when surrounded. Level + cutoff glide (no pops).
  outMusicBedGain: num({ owner: 'audio', unit: 'ratio', doc: 'Gain of the music drone bed at full tension, before music+master bus scaling.', default: 0.4, min: 0, max: 1 }),
  outMusicMinLevel: num({ owner: 'audio', unit: 'ratio', doc: 'Floor level of the music bed when the player is alone (fraction of the bed gain; tension lerps to 1).', default: 0.25, min: 0, max: 1 }),
  outMusicBaseFreqHz: num({ owner: 'audio', unit: 'hz', doc: 'Base frequency of the low music drone.', default: 48, min: 16, max: 400 }),
  outMusicDetuneCents: num({ owner: 'audio', unit: 'ratio', doc: 'Detune (cents) of the second drone oscillator → slow beating, an uneasy bed.', default: 8, min: 0, max: 1200 }),
  outMusicFilterBaseHz: num({ owner: 'audio', unit: 'hz', doc: 'Lowpass cutoff of the music bed at zero tension (calmest, darkest).', default: 180, min: 40, max: 8000 }),
  outMusicFilterRangeHz: num({ owner: 'audio', unit: 'hz', doc: 'How far the lowpass cutoff opens at full tension (added to the base cutoff → edgier, denser).', default: 500, min: 0, max: 8000 }),
  outMusicLfoHz: num({ owner: 'audio', unit: 'hz', doc: 'Slow LFO rate modulating the music-bed filter cutoff (the drone "breathes").', default: 0.05, min: 0.005, max: 4 }),
  outMusicLfoDepthHz: num({ owner: 'audio', unit: 'hz', doc: 'Peak cutoff deviation of the slow filter LFO.', default: 40, min: 0, max: 4000 }),
  outMusicTensionFullCount: num({ owner: 'audio', unit: 'count', doc: 'Nearby horde size at which music tension reaches full (linear ramp below, clamped above).', default: 30, min: 1, max: 100000, integer: true }),
  outMusicGlideSeconds: num({ owner: 'audio', unit: 'seconds', doc: 'Time constant for the music bed level + cutoff to glide toward their tension targets (no pops).', default: 2.5, min: 0.05, max: 30 }),
});
