// T20 / V14 — compact stimulus-driven behaviour (utility scoring over a small FSM).
// `decide` consumes ONLY a PerceptionResult (+ the agent's own position + memory) — it has no
// parameter for player coordinates, so a zombie can react to a queried stimulus yet provably cannot
// react to the player's position in the absence of one (V14). Utility scores each perceived stimulus
// (sight/sound/movement/agitation attract; fire repels), picks the dominant drive, and maps it to an
// FSM transition. Last-known targets are retained for `investigateTicks` after the stimulus fades.
// Run frequency is the caller's concern: hero/active every few ticks, horde tiers far less often.

import { ZombieState } from '@/game/simulation';
import type { PerceivedStimulus, PerceptionResult } from './perception';

export interface BehaviorConfig {
  readonly soundUtilityWeight: number;
  readonly sightUtilityWeight: number;
  readonly agitationUtilityWeight: number;
  readonly fireAvoidUtilityWeight: number;
  readonly investigateTicks: number;
  readonly attackRangeMeters: number;
}

/** Per-agent behaviour memory. Small + serializable (no raw refs — V26). */
export interface BehaviorMemory {
  state: ZombieState;
  hasTarget: boolean;
  targetX: number;
  targetZ: number;
  /** Tick until which a faded stimulus is still investigated. */
  investigateUntilTick: number;
}

export function newMemory(): BehaviorMemory {
  return { state: ZombieState.Idle, hasTarget: false, targetX: 0, targetZ: 0, investigateUntilTick: 0 };
}

export interface BehaviorDecision {
  readonly state: ZombieState;
  readonly hasTarget: boolean;
  readonly targetX: number;
  readonly targetZ: number;
  readonly investigateUntilTick: number;
  /** True when the dominant drive is fleeing fire (target points AWAY from the fire). */
  readonly fleeing: boolean;
  /** Dominant drive utility (diagnostics / tests). */
  readonly utility: number;
}

/** Attraction utility of a single perceived stimulus (fire is handled separately as repulsion). */
function attractUtility(s: PerceivedStimulus, cfg: BehaviorConfig): number {
  switch (s.kind) {
    case 'sight':
    case 'light':
    case 'movement':
      return cfg.sightUtilityWeight * s.intensity;
    case 'sound':
    case 'scent':
      return cfg.soundUtilityWeight * s.intensity;
    case 'agitation':
      return cfg.agitationUtilityWeight * s.intensity;
    case 'fire':
      return 0; // repulsion, not attraction
  }
}

/**
 * Decide the next behaviour from perception + memory. Pure: no side effects, no player coords (V14).
 * `agentX/agentZ` is the agent's OWN position (allowed) — used only for the flee vector.
 */
export function decide(
  memory: BehaviorMemory,
  perception: PerceptionResult,
  agentX: number,
  agentZ: number,
  tick: number,
  cfg: BehaviorConfig,
): BehaviorDecision {
  let bestAttract: PerceivedStimulus | undefined;
  let bestAttractU = 0;
  let bestFire: PerceivedStimulus | undefined;
  let bestFireU = 0;

  for (const s of perception.perceived) {
    if (s.kind === 'fire') {
      const u = cfg.fireAvoidUtilityWeight * s.intensity;
      if (u > bestFireU) {
        bestFireU = u;
        bestFire = s;
      }
      continue;
    }
    const u = attractUtility(s, cfg);
    if (u > bestAttractU) {
      bestAttractU = u;
      bestAttract = s;
    }
  }

  // 1. Fire dominates → flee (target points away from the fire origin).
  if (bestFire && bestFireU >= bestAttractU && bestFireU > 0) {
    const ax = agentX - bestFire.x;
    const az = agentZ - bestFire.z;
    const len = Math.hypot(ax, az) || 1;
    return {
      state: ZombieState.Wander,
      hasTarget: true,
      targetX: agentX + (ax / len),
      targetZ: agentZ + (az / len),
      investigateUntilTick: memory.investigateUntilTick,
      fleeing: true,
      utility: bestFireU,
    };
  }

  // 2. A positive attractor → pursue (or attack when in reach).
  if (bestAttract && bestAttractU > 0) {
    const inReach = bestAttract.distance <= cfg.attackRangeMeters;
    return {
      state: inReach ? ZombieState.Attack : ZombieState.Pursue,
      hasTarget: true,
      targetX: bestAttract.x,
      targetZ: bestAttract.z,
      investigateUntilTick: tick + cfg.investigateTicks,
      fleeing: false,
      utility: bestAttractU,
    };
  }

  // 3. No stimulus this tick — keep investigating a last-known target until it expires.
  if (memory.hasTarget && tick < memory.investigateUntilTick) {
    return {
      state: ZombieState.Pursue,
      hasTarget: true,
      targetX: memory.targetX,
      targetZ: memory.targetZ,
      investigateUntilTick: memory.investigateUntilTick,
      fleeing: false,
      utility: 0,
    };
  }

  // 4. Nothing to chase → wander/idle, target cleared.
  return {
    state: ZombieState.Wander,
    hasTarget: false,
    targetX: 0,
    targetZ: 0,
    investigateUntilTick: 0,
    fleeing: false,
    utility: 0,
  };
}

/** Fold a decision back into memory (caller persists it per agent). */
export function applyDecision(memory: BehaviorMemory, d: BehaviorDecision): void {
  memory.state = d.state;
  memory.hasTarget = d.hasTarget;
  memory.targetX = d.targetX;
  memory.targetZ = d.targetZ;
  memory.investigateUntilTick = d.investigateUntilTick;
}
