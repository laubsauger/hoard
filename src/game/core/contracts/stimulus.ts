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
}
