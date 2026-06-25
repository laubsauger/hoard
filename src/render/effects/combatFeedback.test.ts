// B7 — combat feedback ingest from the VisualEvent stream + muzzle/tracer pulses. Pure logic (no GPU):
// the previously-drained-nowhere event path now spawns pooled gore + fires the muzzle/tracer one-shots.

import { describe, it, expect } from 'vitest';
import {
  CombatFeedbackSystem,
  resolveCombatFeedbackSettings,
  clamp01,
  regionImpactHeight,
  regionBodyRadius,
  silhouetteRadiusAtHeight,
  sprayParticleOffset,
  type IngestContext,
  type RegionHeights,
  type RegionRadii,
  type SprayBallistics,
} from './combatFeedback';
import type { AnatomyRegion, VisualEvent } from '../../game/core/contracts/events';
import type { EntityId, EventId, StimulusId } from '../../game/core/contracts/ids';

const settings = resolveCombatFeedbackSettings('desktop-high');

const camAt0: IngestContext = { cameraX: 0, cameraY: 0, cameraZ: 0, goreIntensity: 1 };

const hitReaction = (energy = 0.8, dirX = 1, dirZ = 0, region: AnatomyRegion = 'torsoUpper'): VisualEvent => ({
  kind: 'hitReaction', id: 1 as EventId, target: 7 as EntityId, region, dirX, dirZ, energy,
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

  it('originates the muzzle/tracer at playerPos + aim*muzzleOffset, in FRONT of the player (T78/V55)', () => {
    const s = new CombatFeedbackSystem(settings);
    const px = 5;
    const pz = 9;
    // Aim along +z (unnormalized magnitude 2) — the origin must offset along the NORMALIZED aim.
    s.fire(px, 1, pz, 0, 2);
    const off = settings.muzzleOffsetMeters;
    expect(off).toBeGreaterThan(0);
    const m = s.muzzlePulse!;
    const t = s.tracerPulse!;
    expect(m.x).toBeCloseTo(px, 6); // no lateral drift
    expect(m.z).toBeCloseTo(pz + off, 6); // pushed forward along +z by exactly the offset
    expect(t.x).toBeCloseTo(px, 6);
    expect(t.z).toBeCloseTo(pz + off, 6);
    // direction normalized.
    expect(Math.hypot(m.dirX, m.dirZ)).toBeCloseTo(1, 6);
  });
});

describe('B14/T71 — energy clamp + region height + directional velocity spray + ground splat (V48)', () => {
  it('clamps a raw out-of-contract energy into [0,1] at ingest (no meters-scale quad)', () => {
    expect(clamp01(50)).toBe(1);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(0.4)).toBeCloseTo(0.4, 6);
    expect(clamp01(Number.NaN)).toBe(0);

    const s = new CombatFeedbackSystem(settings);
    s.ingest([hitReaction(50 /* raw effective damage, the B14 bug */), bloodSpray(2, 1, 3)], camAt0);
    const rec = s.sprayRecords[0]!;
    expect(rec.energy).toBeLessThanOrEqual(1);
    expect(rec.energy).toBe(1); // clamped to the contract ceiling, gore-intensity 1
  });

  it('maps the struck region to its world-height band: head > torso > leg (V48)', () => {
    const h: RegionHeights = settings.regionHeights;
    expect(regionImpactHeight('head', h)).toBe(h.head);
    expect(regionImpactHeight('neck', h)).toBe(h.head);
    expect(regionImpactHeight('torsoUpper', h)).toBe(h.torso);
    expect(regionImpactHeight('armRight', h)).toBe(h.torso);
    expect(regionImpactHeight('legLeft', h)).toBe(h.leg);
    expect(h.head).toBeGreaterThan(h.torso);
    expect(h.torso).toBeGreaterThan(h.leg);
  });

  it('maps the struck region to its body silhouette half-width (torso widest — a humanoid, not a cylinder)', () => {
    const r: RegionRadii = { head: 0.12, torso: 0.24, leg: 0.14 };
    expect(regionBodyRadius('head', r)).toBe(r.head);
    expect(regionBodyRadius('neck', r)).toBe(r.head);
    expect(regionBodyRadius('torsoUpper', r)).toBe(r.torso);
    expect(regionBodyRadius('armLeft', r)).toBe(r.torso);
    expect(regionBodyRadius('legRight', r)).toBe(r.leg);
    expect(r.torso).toBeGreaterThan(r.head); // shoulders wider than the head
    expect(r.torso).toBeGreaterThan(r.leg);
  });

  it('silhouetteRadiusAtHeight tapers leg→torso→head and clamps flat outside the band span', () => {
    const h: RegionHeights = settings.regionHeights;
    const r: RegionRadii = { head: 0.12, torso: 0.24, leg: 0.14 };
    expect(silhouetteRadiusAtHeight(h.leg, h, r)).toBeCloseTo(r.leg, 6); // band anchors hit exactly
    expect(silhouetteRadiusAtHeight(h.torso, h, r)).toBeCloseTo(r.torso, 6);
    expect(silhouetteRadiusAtHeight(h.head, h, r)).toBeCloseTo(r.head, 6);
    expect(silhouetteRadiusAtHeight(-5, h, r)).toBeCloseTo(r.leg, 6); // below the feet → clamp to leg
    expect(silhouetteRadiusAtHeight(99, h, r)).toBeCloseTo(r.head, 6); // above the head → clamp to head
    // mid-band interpolation sits strictly between the two anchors (widest at torso → narrows toward head).
    const midUp = silhouetteRadiusAtHeight((h.torso + h.head) / 2, h, r);
    expect(midUp).toBeLessThan(r.torso);
    expect(midUp).toBeGreaterThan(r.head);
  });

  it('carries the struck region from hitReaction onto the spray record', () => {
    const s = new CombatFeedbackSystem(settings);
    s.ingest([hitReaction(0.8, 1, 0, 'head'), bloodSpray(0, 0, 5)], camAt0);
    expect(s.sprayRecords[0]!.region).toBe('head');
  });

  it('spawns N droplets travelling with non-zero velocity ALONG the hit vector (V48)', () => {
    const b: SprayBallistics = settings.sprayBallistics;
    const dirX = 1;
    const dirZ = 0;
    const age = 0.1;
    const n = 8;
    let allForwardPositive = true;
    let distinctPositions = 0;
    const seen = new Set<string>();
    for (let i = 0; i < n; i += 1) {
      const off = sprayParticleOffset(42, i, age, dirX, dirZ, b);
      const forward = off.x * dirX + off.z * dirZ; // projection onto the impact vector
      if (forward <= 0) allForwardPositive = false;
      const key = `${off.x.toFixed(4)},${off.z.toFixed(4)}`;
      if (!seen.has(key)) {
        seen.add(key);
        distinctPositions += 1;
      }
    }
    expect(allForwardPositive).toBe(true); // every droplet moves along the hit vector
    expect(distinctPositions).toBeGreaterThan(1); // spread, not a single coincident point

    // At age 0 there is no displacement; velocity manifests over time.
    const atZero = sprayParticleOffset(42, 0, 0, dirX, dirZ, b);
    expect(atZero.x).toBeCloseTo(0, 12);
    expect(atZero.y).toBeCloseTo(0, 12);
    expect(atZero.z).toBeCloseTo(0, 12);

    // The whole spray record reports its (intensity-scaled) particle count.
    const s = new CombatFeedbackSystem(settings);
    s.ingest([hitReaction(1), bloodSpray(0, 1, 1)], camAt0);
    expect(s.sprayRecords[0]!.particles).toBeGreaterThan(1);
  });

  it('lays a persistent ground splat at the projected impact point that fades over its lifetime (V48)', () => {
    const s = new CombatFeedbackSystem(settings);
    s.ingest([hitReaction(0.9), bloodSpray(4, 1, 6)], camAt0);
    const stains = s.stainRecords;
    expect(stains).toHaveLength(1);
    expect(stains[0]!.x).toBe(4);
    expect(stains[0]!.z).toBe(6);
    expect(stains[0]!.y).toBe(0); // laid flat on the ground

    // Fresh splat fades ~1; near end of its (long) lifetime it approaches 0; outlives the airborne sparks.
    expect(s.stainFade(stains[0]!)).toBeCloseTo(1, 1);
    expect(settings.stainLifetimeSeconds).toBeGreaterThan(settings.sparkLifetimeSeconds);
    s.update(settings.sparkLifetimeSeconds + 0.5); // airborne sparks gone, splat persists
    expect(s.sprayRecords).toHaveLength(0);
    expect(s.stainRecords).toHaveLength(1);
    s.update(settings.stainLifetimeSeconds); // past the splat lifetime
    expect(s.stainRecords).toHaveLength(0);
  });

  it('suppresses the ground splat too at gore-intensity 0 (V29)', () => {
    const s = new CombatFeedbackSystem(settings);
    s.ingest([hitReaction(), bloodSpray()], { ...camAt0, goreIntensity: 0 });
    expect(s.stainRecords).toHaveLength(0);
  });
});

describe('B15/T74 — tracer terminates at the actual stop distance (V49)', () => {
  it('uses the explicit struck-body travel on a hit and max range on a clean miss', () => {
    const range = settings.tracerRangeMeters;

    const hit = new CombatFeedbackSystem(settings);
    hit.fire(0, 1, 0, 1, 0, 7 /* travelMeters */);
    expect(hit.tracerStopDistance()).toBe(7);

    const miss = new CombatFeedbackSystem(settings);
    miss.fire(0, 1, 0, 1, 0); // clean miss — no stop distance
    expect(miss.tracerStopDistance()).toBe(range);

    const clamped = new CombatFeedbackSystem(settings);
    clamped.fire(0, 1, 0, 1, 0, range + 1000); // never beyond max range
    expect(clamped.tracerStopDistance()).toBe(range);
  });

  it('derives the stop from a struck-body bloodSpray impact when fire() had no explicit distance', () => {
    const s = new CombatFeedbackSystem(settings);
    s.fire(0, 1, 0, 1, 0); // body at origin, aiming +x → muzzle at +x*muzzleOffset (T78/V55), no explicit stop
    expect(s.tracerStopDistance()).toBe(settings.tracerRangeMeters);
    // First struck body 6 m down-range along +x — distance is measured FROM the muzzle, not the body centre.
    s.ingest([hitReaction(0.8, 1, 0), bloodSpray(6, 1, 0)], camAt0);
    expect(s.tracerStopDistance()).toBeCloseTo(6 - settings.muzzleOffsetMeters, 6);
  });

  it('ignores an impact behind the muzzle (not this shot)', () => {
    const s = new CombatFeedbackSystem(settings);
    s.fire(0, 1, 0, 1, 0);
    s.ingest([hitReaction(0.8, 1, 0), bloodSpray(-5, 1, 0)], camAt0);
    expect(s.tracerStopDistance()).toBe(settings.tracerRangeMeters); // unchanged
  });

  it('an explicit stop distance wins over a later impact', () => {
    const s = new CombatFeedbackSystem(settings);
    s.fire(0, 1, 0, 1, 0, 4);
    s.ingest([hitReaction(0.8, 1, 0), bloodSpray(20, 1, 0)], camAt0);
    expect(s.tracerStopDistance()).toBe(4);
  });
});

describe('tracer fan (T139 shotgun scatter visual)', () => {
  it('emits one tracer per pellet, fanned across the spread; a single-pellet shot is one tracer', () => {
    const s = new CombatFeedbackSystem(settings);
    s.fire(0, 1, 0, 1, 0, undefined, 8, 14); // 8 pellets across a 14° cone
    expect(s.tracerPulses.length).toBe(8);
    const headings = s.tracerPulses.map((t) => Math.atan2(t.dirZ, t.dirX));
    // the pellet directions span the cone (~14° ≈ 0.24 rad), not all identical.
    expect(Math.max(...headings) - Math.min(...headings)).toBeGreaterThan(0.15);

    s.fire(0, 1, 0, 1, 0); // default single pellet
    expect(s.tracerPulses.length).toBe(1);
    expect(s.tracerPulses[0]!.dirX).toBeCloseTo(1);
  });

  it('caps the fan at MAX_TRACERS so a huge pellet count never overruns the view pool', () => {
    const s = new CombatFeedbackSystem(settings);
    s.fire(0, 1, 0, 1, 0, undefined, 999, 30);
    expect(s.tracerPulses.length).toBeLessThanOrEqual(12);
    expect(s.tracerPulses.length).toBeGreaterThan(1);
  });
});
