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
});
