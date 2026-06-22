// T20 / V14 — stimulus-driven perception.
// V14: zombies NEVER receive omniscient player coords. The ONLY way a zombie learns about the world
// is by querying the StimulusField at its own position: sound, sight, light, movement, agitation,
// fire, scent. A stimulus is perceived only when (a) the agent is within the archetype's sense range
// for that stimulus' modality AND (b) its attenuated intensity clears the alert threshold. This
// module takes a StimulusField (read-only) + the agent position — it has no channel for player
// coordinates, which structurally enforces V14.

import type { StimulusField, StimulusHit } from '@/game/stimulus';
import type { StimulusKind, StimulusSource } from '@/game/core/contracts';
import type { PerceptionProfile } from './archetype';

export interface PerceptionConfig {
  /** Minimum attenuated intensity that can register at all. */
  readonly alertIntensityThreshold: number;
}

export interface PerceivedStimulus {
  readonly kind: StimulusKind;
  readonly source: StimulusSource;
  readonly x: number;
  readonly z: number;
  /** Attenuated intensity reaching the agent. */
  readonly intensity: number;
  /** Distance from the agent to the stimulus origin (meters). */
  readonly distance: number;
}

export interface PerceptionResult {
  /** Every perceivable stimulus this tick, strongest first. */
  readonly perceived: PerceivedStimulus[];
}

/** Which archetype sense range gates a stimulus modality. */
function rangeForKind(kind: StimulusKind, p: PerceptionProfile): number {
  switch (kind) {
    case 'sight':
    case 'light':
    case 'movement':
      return p.sightRange;
    case 'sound':
    case 'agitation':
    case 'scent':
      return p.hearingRange;
    case 'fire':
      // fire is both seen and heard — use the wider sense.
      return Math.max(p.sightRange, p.hearingRange);
  }
}

/**
 * Perceive the world at (x,z) on `tick`. Pure read of the StimulusField — no player coordinates ever
 * enter this function (V14). Returns the perceivable stimuli sorted by attenuated intensity.
 */
export function perceive(
  field: StimulusField,
  x: number,
  z: number,
  tick: number,
  archetype: PerceptionProfile,
  cfg: PerceptionConfig,
): PerceptionResult {
  const hits: StimulusHit[] = field.query(x, z, tick);
  const perceived: PerceivedStimulus[] = [];
  for (const h of hits) {
    if (h.intensity < cfg.alertIntensityThreshold) continue;
    const range = rangeForKind(h.stimulus.kind, archetype);
    const dx = x - h.stimulus.x;
    const dz = z - h.stimulus.z;
    const distance = Math.hypot(dx, dz);
    if (distance > range) continue; // out of this agent's sensing range for that modality
    perceived.push({
      kind: h.stimulus.kind,
      source: h.stimulus.source,
      x: h.stimulus.x,
      z: h.stimulus.z,
      intensity: h.intensity,
      distance,
    });
  }
  perceived.sort((a, b) => b.intensity - a.intensity);
  return { perceived };
}
