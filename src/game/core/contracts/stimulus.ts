// T42 (coordinated extension, Wave-2) / V14 / V28 — stimulus contract. Frozen.
// Perception is stimulus-driven: zombies never get omniscient player coords (V14). Audio + combat +
// fire + destruction PRODUCE stimuli; behavior CONSUMES them. One shared type so both sides agree.

import type { StimulusId } from './ids';

/** What sense the stimulus excites. */
export type StimulusKind = 'sound' | 'sight' | 'light' | 'movement' | 'agitation' | 'fire' | 'scent';

/** Where it came from (drives material/identity reactions + audio class). */
export type StimulusSource =
  | 'gunfire'
  | 'glass'
  | 'alarm'
  | 'impact'
  | 'footstep'
  | 'voice'
  | 'fire'
  | 'breach'
  | 'player'
  | 'weather';

export interface Stimulus {
  readonly id: StimulusId;
  readonly kind: StimulusKind;
  readonly source: StimulusSource;
  /** World-plane origin (meters). */
  readonly x: number;
  readonly z: number;
  /** Normalized strength 0..1 at origin. */
  readonly intensity: number;
  /** Effective radius (meters) at birth. */
  readonly radius: number;
  /** Authoritative tick the stimulus was emitted on. */
  readonly bornTick: number;
  /** Intensity lost per tick (>=0). When intensity <= 0 the stimulus is retired. */
  readonly decayPerTick: number;
  /**
   * P3 multi-floor: the nav LEVEL the stimulus originated on (0 = ground). OPTIONAL + additive — every existing
   * producer omits it (⇒ undefined ⇒ treated as level 0), so the single-floor sim is byte-identical. A consumer
   * on a DIFFERENT level attenuates the reaching intensity by the sound-through-floor factor (V4) — a gunshot
   * downstairs is heard upstairs, muffled, via the stairwell. The frozen XZ-plane contract is otherwise intact.
   */
  readonly level?: number;
}
