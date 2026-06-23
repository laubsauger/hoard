// B7 — combat feedback ingest from the VisualEvent stream + muzzle/tracer pulses. Pure logic (no GPU):
// the previously-drained-nowhere event path now spawns pooled gore + fires the muzzle/tracer one-shots.

import { describe, it, expect } from 'vitest';
import { CombatFeedbackSystem, resolveCombatFeedbackSettings, type IngestContext } from './combatFeedback';
import type { VisualEvent } from '../../game/core/contracts/events';
import type { EntityId, EventId, StimulusId } from '../../game/core/contracts/ids';

const settings = resolveCombatFeedbackSettings('desktop-high');

const camAt0: IngestContext = { cameraX: 0, cameraY: 0, cameraZ: 0, goreIntensity: 1 };

const hitReaction = (energy = 0.8, dirX = 1, dirZ = 0): VisualEvent => ({
  kind: 'hitReaction', id: 1 as EventId, target: 7 as EntityId, region: 'torsoUpper', dirX, dirZ, energy,
});
const bloodSpray = (x = 2, y = 1, z = 3): VisualEvent => ({
  kind: 'bloodSpray', id: 2 as EventId, x, y, z, dirX: 1, dirZ: 0,
});
const partDetached = (): VisualEvent => ({
  kind: 'partDetached', id: 3 as EventId, target: 7 as EntityId, region: 'armLeft',
});
const sound = (): VisualEvent => ({
  kind: 'soundEmitted', id: 4 as EventId, stimulus: 5 as StimulusId, x: 0, z: 0, intensity: 1,
});

describe('CombatFeedbackSystem (B7 event ingest)', () => {
  it('spawns a positioned, energy-weighted blood spray from a paired hitReaction -> bloodSpray', () => {
    const s = new CombatFeedbackSystem(settings);
    s.ingest([hitReaction(0.9), bloodSpray(2, 1, 3)], camAt0);
    const sprays = s.sprayRecords;
    expect(sprays).toHaveLength(1);
    const rec = sprays[0]!;
    expect(rec.x).toBe(2);
    expect(rec.y).toBe(1);
    expect(rec.z).toBe(3);
    expect(rec.energy).toBeCloseTo(0.9, 6); // inherited the hit energy (gore-intensity 1)
  });

  it('places a sever marker at the last impact on partDetached', () => {
    const s = new CombatFeedbackSystem(settings);
    s.ingest([hitReaction(), bloodSpray(4, 0, 5), partDetached()], camAt0);
    const sever = s.severRecords;
    expect(sever).toHaveLength(1);
    expect(sever[0]!.x).toBe(4);
    expect(sever[0]!.z).toBe(5);
  });

  it('ignores soundEmitted (not gore)', () => {
    const s = new CombatFeedbackSystem(settings);
    s.ingest([sound()], camAt0);
    expect(s.sprayRecords).toHaveLength(0);
    expect(s.severRecords).toHaveLength(0);
  });

  it('fully suppresses gore at gore-intensity 0 (V29 accessibility)', () => {
    const s = new CombatFeedbackSystem(settings);
    s.ingest([hitReaction(), bloodSpray(), partDetached()], { ...camAt0, goreIntensity: 0 });
    expect(s.sprayRecords).toHaveLength(0);
    expect(s.severRecords).toHaveLength(0);
  });

  it('ages gore out after its lifetime and the muzzle/tracer pulses after theirs', () => {
    const s = new CombatFeedbackSystem(settings);
    s.fire(0, 1, 0, 1, 0);
    s.ingest([hitReaction(), bloodSpray()], camAt0);
    expect(s.muzzleIntensity01()).toBeGreaterThan(0);
    expect(s.tracerAlpha01()).toBeGreaterThan(0);
    expect(s.sprayRecords.length).toBeGreaterThan(0);

    // Advance well past every configured lifetime.
    const longDt = Math.max(settings.sparkLifetimeSeconds, settings.muzzleFlashSeconds, settings.tracerSeconds) + 1;
    s.update(longDt);
    expect(s.muzzleIntensity01()).toBe(0);
    expect(s.tracerAlpha01()).toBe(0);
    expect(s.sprayRecords).toHaveLength(0);
  });

  it('fades the muzzle flash + tracer linearly over their lifetimes', () => {
    const s = new CombatFeedbackSystem(settings);
    s.fire(0, 1, 0, 1, 0);
    const full = s.muzzleIntensity01();
    s.update(settings.muzzleFlashSeconds / 2);
    const half = s.muzzleIntensity01();
    expect(half).toBeLessThan(full);
    expect(half).toBeGreaterThan(0);
  });

  it('rejects a negative dt (V4)', () => {
    const s = new CombatFeedbackSystem(settings);
    expect(() => s.update(-1)).toThrow();
  });
});
