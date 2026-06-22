// T27 tests — V28/V14: a heard event produces a Stimulus emitted into the injected field that a
// query attenuates with distance; a loud event also registers a persistent disturbance that lingers
// past the sample; horde vocalization is a group bed + a few foreground voices (NOT one per member);
// the coarse sector graph spreads sound through attenuation links and stops below the floor.

import { describe, it, expect } from 'vitest';
import { AudioSim } from './audioSim';
import { SectorSoundGraph } from './sectorSoundGraph';
import { StimulusField } from '@/game/stimulus';
import { IdFactory } from '@/game/core/ids';

function sim(field = new StimulusField(128)) {
  return { field, audio: new AudioSim({ ids: new IdFactory(), field }) };
}

describe('audio — heard event becomes an attenuating Stimulus (V14/V28)', () => {
  it('a gunshot emits a Stimulus into the field that a distant query hears weaker', () => {
    const { field, audio } = sim();
    const stim = audio.hearEvent('gunfire', 0, 0, 0);
    expect(stim.kind).toBe('sound');
    expect(stim.source).toBe('gunfire');

    const near = field.query(0, 0, 0);
    const far = field.query(60, 0, 0); // within the 120m reach
    const beyond = field.query(200, 0, 0); // outside it

    const nearI = near.find((h) => h.stimulus.id === stim.id)!.intensity;
    const farI = far.find((h) => h.stimulus.id === stim.id)!.intensity;
    expect(farI).toBeGreaterThan(0);
    expect(farI).toBeLessThan(nearI); // distance attenuation
    expect(beyond.some((h) => h.stimulus.id === stim.id)).toBe(false);
  });

  it('obstruction lowers the heard intensity', () => {
    const { field, audio } = sim();
    const open = audio.hearEvent('impact', 0, 0, 0);
    const muffled = audio.hearEvent('impact', 0, 0, 0, { obstruction: 0.8 });
    expect(muffled.intensity).toBeLessThan(open.intensity);
    expect(field.activeCount).toBeGreaterThan(0);
  });
});

describe('audio — persistent disturbance after a major event (V28)', () => {
  it('a loud event lingers and keeps influencing migration after the sample', () => {
    const { audio } = sim();
    audio.hearEvent('gunfire', 0, 0, 100); // intensity 1 >= major threshold 0.8
    expect(audio.activeDisturbances(100)).toBeGreaterThan(0);
    expect(audio.activeDisturbances(300)).toBeGreaterThan(0); // still lingering
    expect(audio.activeDisturbances(100 + 1000)).toBe(0); // eventually gone
  });

  it('a quiet event registers no persistent disturbance', () => {
    const { audio } = sim();
    audio.hearEvent('footstep', 0, 0, 0);
    expect(audio.activeDisturbances(0)).toBe(0);
  });
});

describe('audio — horde vocalization beds (V28)', () => {
  it('a large group collapses to one bed + a few foreground voices, never one per member', () => {
    const { audio } = sim();
    const stims = audio.vocalize(50, 0, 0, 0);
    expect(stims.length).toBe(1 + audio.settings.hordeForegroundVoices); // not 50
    expect(stims.every((s) => s.source === 'voice')).toBe(true);
  });

  it('a small group may voice per member', () => {
    const { audio } = sim();
    expect(audio.vocalize(3, 0, 0, 0).length).toBe(3);
  });
});

describe('audio — coarse sector sound graph (V28)', () => {
  it('propagates with per-link attenuation and stops below the floor', () => {
    const g = new SectorSoundGraph();
    g.addLink(0, 1, 'breach'); // high transmission
    g.addLink(1, 2, 'wall'); // heavy attenuation
    g.addLink(2, 3, 'wall'); // pushes below the floor
    const reach = g.propagate(0, 1);
    expect(reach.get(0)).toBe(1);
    expect(reach.get(2)!).toBeGreaterThan(0);
    expect(reach.get(2)!).toBeLessThan(reach.get(1)!); // wall attenuates more than a breach
    expect(reach.has(3)).toBe(false); // fell below minPropagatedIntensity
  });
});
