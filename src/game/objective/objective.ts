// T40 — medium-term OBJECTIVE state machine (milestone-2). Hybrid sandbox + direction (§C): the player
// is given a clear medium-term goal (scavenge radio parts -> repair the radio -> call evacuation -> reach
// the exit) but MAY ignore it indefinitely while they fortify/explore. The ONLY hard timer is the
// evacuation countdown, which the player themselves arms by calling evacuation — that arming is what
// triggers the decisive horde event (the climax). Progress is driven by COMMANDS (V1: UI issues intent,
// the engine validates and advances); the system never reads per-frame world state. A compact snapshot is
// published to the HUD. Every threshold comes from typed config (V4), never a literal here.

import { resolveDomain } from '@/config/registry';
import { gameConfig } from '@/config/domains/game';
import type { QualityTier } from '@/config/types';

/** Objective phases, in completion order. `failed` is terminal alongside `evacuated`. */
export type ObjectivePhase =
  | 'locateParts'
  | 'repairRadio'
  | 'callEvacuation'
  | 'evacuating'
  | 'evacuated'
  | 'failed';

export const OBJECTIVE_PHASES: readonly ObjectivePhase[] = [
  'locateParts', 'repairRadio', 'callEvacuation', 'evacuating', 'evacuated', 'failed',
];

/** Compact, HUD-facing objective snapshot (published via a throttled gate — never per-frame state). */
export interface ObjectiveSnapshot {
  readonly phase: ObjectivePhase;
  readonly partsFound: number;
  readonly partsRequired: number;
  readonly repairProgressTicks: number;
  readonly repairRequiredTicks: number;
  /** Ticks left on the evacuation countdown; null unless phase === 'evacuating'. */
  readonly evacuationTicksRemaining: number | null;
  /** Whether the current phase can be advanced by the player right now (gates the HUD action). */
  readonly canAdvance: boolean;
  /** Short human-readable directive for the HUD. */
  readonly directive: string;
}

/** Persisted objective state (round-trips through the district save — V9/V23). */
export interface ObjectiveSave {
  readonly phase: ObjectivePhase;
  readonly partsFound: number;
  readonly repairProgressTicks: number;
  /** Absolute tick the evacuation countdown ends (null unless evacuating). */
  readonly evacuationDeadlineTick: number | null;
}

export interface ObjectiveSettings {
  readonly partsRequired: number;
  readonly repairRequiredTicks: number;
  readonly evacuationCountdownTicks: number;
}

export function resolveObjectiveSettings(tier: QualityTier): ObjectiveSettings {
  const g = resolveDomain(gameConfig, tier);
  return {
    partsRequired: g.objectivePartsRequired,
    repairRequiredTicks: g.radioRepairTicks,
    evacuationCountdownTicks: g.evacuationCountdownTicks,
  };
}

const DIRECTIVES: Record<ObjectivePhase, string> = {
  locateParts: 'Scavenge radio parts',
  repairRadio: 'Repair the radio',
  callEvacuation: 'Call for evacuation',
  evacuating: 'Reach the exit before the horde arrives',
  evacuated: 'Evacuated — you survived',
  failed: 'Objective failed',
};

/**
 * The objective FSM. Transitions are explicit and validated; an illegal transition reports cleanly via a
 * failed CommandResult-style boolean rather than corrupting state (no brittle fallback, V4). The player
 * may sit in `locateParts`/`repairRadio`/`callEvacuation` indefinitely (sandbox); only `evacuating` is
 * time-bounded. `callEvacuation` is the seam the runtime watches to fire the decisive horde event.
 */
export class ObjectiveSystem {
  private phase: ObjectivePhase = 'locateParts';
  private partsFound = 0;
  private repairProgressTicks = 0;
  private evacuationDeadlineTick: number | null = null;

  constructor(private readonly settings: ObjectiveSettings) {}

  get currentPhase(): ObjectivePhase {
    return this.phase;
  }

  /** True once the current phase's precondition is met and `advance()` will succeed. */
  canAdvance(): boolean {
    switch (this.phase) {
      case 'locateParts':
        return this.partsFound >= this.settings.partsRequired;
      case 'repairRadio':
        return this.repairProgressTicks >= this.settings.repairRequiredTicks;
      case 'callEvacuation':
        return true;
      default:
        return false;
    }
  }

  /** Collect one radio part (player command). Caps at the requirement; returns the new count. */
  collectPart(): number {
    if (this.phase !== 'locateParts') return this.partsFound;
    this.partsFound = Math.min(this.settings.partsRequired, this.partsFound + 1);
    return this.partsFound;
  }

  /**
   * Accumulate repair work (player command, in ticks). Only meaningful in `repairRadio`. Returns the new
   * progress. The player MAY stop and resume later — there is no decay (sandbox).
   */
  applyRepairTicks(ticks: number): number {
    if (!Number.isFinite(ticks) || ticks < 0) throw new Error(`repair ticks must be a non-negative finite number, got ${ticks}`);
    if (this.phase !== 'repairRadio') return this.repairProgressTicks;
    this.repairProgressTicks = Math.min(this.settings.repairRequiredTicks, this.repairProgressTicks + ticks);
    return this.repairProgressTicks;
  }

  /**
   * Advance to the next phase if the precondition is met. `now` (absolute tick) is required when advancing
   * INTO `evacuating` so the countdown deadline is anchored. Returns whether the advance happened.
   * Advancing from `callEvacuation` arms the decisive climax (the runtime triggers the horde event).
   */
  advance(now: number): boolean {
    if (!this.canAdvance()) return false;
    switch (this.phase) {
      case 'locateParts':
        this.phase = 'repairRadio';
        return true;
      case 'repairRadio':
        this.phase = 'callEvacuation';
        return true;
      case 'callEvacuation':
        this.phase = 'evacuating';
        this.evacuationDeadlineTick = now + this.settings.evacuationCountdownTicks;
        return true;
      default:
        return false;
    }
  }

  /** Player reached the exit during evacuation — the objective is complete. Returns success. */
  reachExit(): boolean {
    if (this.phase !== 'evacuating') return false;
    this.phase = 'evacuated';
    this.evacuationDeadlineTick = null;
    return true;
  }

  /** Hard-fail the objective (player died, or evacuation timed out). Terminal. */
  fail(): void {
    if (this.phase === 'evacuated') return; // already won — never demote a win.
    this.phase = 'failed';
  }

  /**
   * Per-tick maintenance: while evacuating, fail if the countdown elapsed. Returns true on the tick the
   * deadline is first missed (so the runtime can react once). Safe to call every tick.
   */
  tick(now: number): boolean {
    if (this.phase === 'evacuating' && this.evacuationDeadlineTick !== null && now > this.evacuationDeadlineTick) {
      this.fail();
      return true;
    }
    return false;
  }

  snapshot(now: number): ObjectiveSnapshot {
    const remaining =
      this.phase === 'evacuating' && this.evacuationDeadlineTick !== null
        ? Math.max(0, this.evacuationDeadlineTick - now)
        : null;
    return {
      phase: this.phase,
      partsFound: this.partsFound,
      partsRequired: this.settings.partsRequired,
      repairProgressTicks: this.repairProgressTicks,
      repairRequiredTicks: this.settings.repairRequiredTicks,
      evacuationTicksRemaining: remaining,
      canAdvance: this.canAdvance(),
      directive: DIRECTIVES[this.phase],
    };
  }

  /** Capture for persistence (V9 — compact delta). */
  save(): ObjectiveSave {
    return {
      phase: this.phase,
      partsFound: this.partsFound,
      repairProgressTicks: this.repairProgressTicks,
      evacuationDeadlineTick: this.evacuationDeadlineTick,
    };
  }

  /** Restore from persistence into a fresh system (validates the phase enum — V23/V4). */
  restore(s: ObjectiveSave): void {
    if (!OBJECTIVE_PHASES.includes(s.phase)) throw new Error(`unknown objective phase '${s.phase}'`);
    this.phase = s.phase;
    this.partsFound = Math.min(this.settings.partsRequired, Math.max(0, s.partsFound));
    this.repairProgressTicks = Math.min(this.settings.repairRequiredTicks, Math.max(0, s.repairProgressTicks));
    this.evacuationDeadlineTick = s.evacuationDeadlineTick;
  }
}
