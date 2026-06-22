// T25 / V18 / V30 — modification classes layered on the StructuralModule (extends destruction, does
// NOT rebuild it). Each modification feeds the world the same way: a persistent WorldEvent, a sound
// Stimulus emitted into the injected StimulusField (perception input, V14/V28), and a LOCAL nav/path
// consequence (V5 — never a full region rebuild). Classes covered:
//   - functional-mod hardening: board / reinforce / brace / weld   (add strength + maybe block nav)
//   - functional-mod access:    lock / unlock / open / close       (toggle passability)
//   - breach-creation:          breach                              (reuses StructuralModule.applyDamage)
//   - obstruction:              obstruct / clearObstruction         (furniture/debris/vehicle path-cost)
//   - support-damage:           supportDamage                       (collapse / route deletion)
//   - utility work:             cutPower / restorePower / silenceAlarm
// Functional + obstruction state is tracked as a COMPACT persistent delta here (V18), separate from
// the structural strength delta the module already keeps.

import { resolveDomain } from '@/config/registry';
import { destructionConfig } from '@/config/domains/destruction';
import type { QualityTier, ResolvedDomain } from '@/config/types';
import type {
  Command,
  CommandResult,
  EventId,
  ModuleId,
  Stimulus,
  StimulusId,
  StimulusSource,
  StructureOp,
  VisualEvent,
  WorldEvent,
} from '@/game/core/contracts';
import type { StimulusField } from '@/game/stimulus';
import type { IdFactory } from '@/game/core/ids';
import { StructuralModule, type BreachResult, type StructuralHooks } from './structuralModule';

export type DestructionSettings = ResolvedDomain<typeof destructionConfig>;

const REFERENCE_TIER: QualityTier = 'desktop-high';

export type AccessState = 'open' | 'closed' | 'locked';

/** Compact persistent record for a functionally-modified / obstructed cell (V18). */
export interface FunctionalDelta {
  readonly module: number;
  readonly cell: number;
  access: AccessState;
  boarded: boolean;
  obstructed: boolean;
}

export interface ModifierDeps {
  readonly ids: IdFactory;
  readonly field: StimulusField;
  /** Receive persistent WorldEvents (structureModified / breachCreated). */
  readonly emit: (event: WorldEvent) => void;
  /** Map a module-local cell to its world-plane position (for placing the sound Stimulus). */
  readonly locate: (module: ModuleId, cell: number) => { x: number; z: number };
  /** LOCAL nav: make a cell impassable (board/close/lock). */
  readonly blockCell?: (module: ModuleId, cell: number) => void;
  /** LOCAL nav: make a cell passable (unlock+open / breach). */
  readonly openCell?: (module: ModuleId, cell: number) => void;
  /** LOCAL path-cost: add traversal penalty (obstruction). */
  readonly obstructCell?: (module: ModuleId, cell: number, addedCost: number) => void;
  /** LOCAL path-cost: remove an obstruction penalty. */
  readonly clearObstruction?: (module: ModuleId, cell: number) => void;
  /** Optional ephemeral sound event for render/audio mixing. */
  readonly emitVisual?: (event: VisualEvent) => void;
  readonly tier?: QualityTier;
}

function fkey(module: ModuleId, cell: number): string {
  return `${module}:${cell}`;
}

export class StructureModifier {
  readonly settings: DestructionSettings;
  private readonly deps: ModifierDeps;
  private readonly functional = new Map<string, FunctionalDelta>();

  constructor(deps: ModifierDeps) {
    this.settings = resolveDomain(destructionConfig, deps.tier ?? REFERENCE_TIER);
    this.deps = deps;
  }

  private record(module: ModuleId, cell: number): FunctionalDelta {
    const k = fkey(module, cell);
    let d = this.functional.get(k);
    if (!d) {
      d = { module: module as number, cell, access: 'open', boarded: false, obstructed: false };
      this.functional.set(k, d);
    }
    return d;
  }

  /** Functional/obstruction state delta to persist alongside the structural strength delta (V18). */
  modificationDelta(): FunctionalDelta[] {
    return [...this.functional.values()].map((d) => ({ ...d }));
  }

  getState(module: ModuleId, cell: number): Readonly<FunctionalDelta> | undefined {
    return this.functional.get(fkey(module, cell));
  }

  isBlocked(module: ModuleId, cell: number): boolean {
    const d = this.functional.get(fkey(module, cell));
    return d ? d.access !== 'open' || d.boarded : false;
  }

  // ---- shared emit helpers ----
  private emitWorld(event: WorldEvent): void {
    this.deps.emit(event);
  }

  private emitSound(module: ModuleId, cell: number, tick: number, source: StimulusSource = 'impact', intensity?: number, radius?: number): Stimulus {
    const { x, z } = this.deps.locate(module, cell);
    const id = this.deps.ids.next<StimulusId>('stimulus');
    const stim: Stimulus = {
      id,
      kind: 'sound',
      source,
      x,
      z,
      intensity: intensity ?? this.settings.modificationSoundIntensity,
      radius: radius ?? this.settings.modificationSoundRadiusMeters,
      bornTick: tick,
      decayPerTick: this.settings.modificationSoundDecayPerTick,
    };
    this.deps.field.emit(stim, tick);
    this.deps.emitVisual?.({ kind: 'soundEmitted', id: this.deps.ids.next<EventId>('event'), stimulus: id, x, z, intensity: stim.intensity });
    return stim;
  }

  private structureModified(module: ModuleId, cell: number): void {
    this.emitWorld({ kind: 'structureModified', id: this.deps.ids.next<EventId>('event'), module, cell });
  }

  // ---- functional-mod: hardening ----
  /** Board over a cell: adds plank strength, closes + blocks the opening (nav consequence). */
  board(module: StructuralModule, cell: number, tick: number): void {
    module.reinforce(cell, this.settings.boardStrengthBonus);
    const d = this.record(module.id, cell);
    d.boarded = true;
    d.access = 'closed';
    this.deps.blockCell?.(module.id, cell);
    this.structureModified(module.id, cell);
    this.emitSound(module.id, cell, tick);
  }

  /** Reinforce/brace/weld: multiply effective strength so it resists more damage before breaching. */
  reinforce(module: StructuralModule, cell: number, tick: number): void {
    const c = module.getCell(cell);
    if (!c) throw new Error(`cannot reinforce empty cell ${cell}`);
    const added = c.maxStrength * (this.settings.reinforceStrengthMultiplier - 1);
    module.reinforce(cell, added);
    this.structureModified(module.id, cell);
    this.emitSound(module.id, cell, tick);
  }

  // ---- functional-mod: access ----
  lock(module: StructuralModule, cell: number, tick: number): void {
    const d = this.record(module.id, cell);
    d.access = 'locked';
    this.deps.blockCell?.(module.id, cell);
    this.structureModified(module.id, cell);
    this.emitSound(module.id, cell, tick, 'impact');
  }

  unlock(module: StructuralModule, cell: number, tick: number): void {
    const d = this.record(module.id, cell);
    d.access = 'closed';
    this.structureModified(module.id, cell);
    this.emitSound(module.id, cell, tick, 'impact');
  }

  close(module: StructuralModule, cell: number, tick: number): void {
    const d = this.record(module.id, cell);
    if (d.access === 'locked') throw new Error(`cell ${cell} is locked; unlock before closing/opening`);
    d.access = 'closed';
    this.deps.blockCell?.(module.id, cell);
    this.structureModified(module.id, cell);
    this.emitSound(module.id, cell, tick, 'impact');
  }

  open(module: StructuralModule, cell: number, tick: number): void {
    const d = this.record(module.id, cell);
    if (d.access === 'locked') throw new Error(`cell ${cell} is locked; unlock before opening`);
    if (d.boarded) throw new Error(`cell ${cell} is boarded; remove boards before opening`);
    d.access = 'open';
    this.deps.openCell?.(module.id, cell);
    this.structureModified(module.id, cell);
    this.emitSound(module.id, cell, tick, 'impact');
  }

  // ---- breach-creation (reuses the existing applyDamage path; NO full rebuild) ----
  /** Force a breach by removing the cell's remaining strength. Returns the breach footprint. */
  breach(module: StructuralModule, cell: number, tick: number): BreachResult {
    const c = module.getCell(cell);
    if (!c) throw new Error(`cannot breach empty cell ${cell}`);
    const hooks = this.structuralHooks();
    const result = module.applyDamage(cell, c.strength, hooks);
    if (!result) throw new Error(`breach of cell ${cell} did not cross threshold`);
    this.emitSound(module.id, cell, tick, 'breach', undefined, this.settings.modificationSoundRadiusMeters);
    return result;
  }

  // ---- support-damage (collapse / route deletion) ----
  /** Damage a (typically load-bearing) cell. Crossing threshold can collapse unsupported dependents. */
  supportDamage(module: StructuralModule, cell: number, amount: number, tick: number): BreachResult | null {
    const hooks = this.structuralHooks();
    const result = module.applyDamage(cell, amount, hooks);
    this.emitSound(module.id, cell, tick, 'impact');
    return result;
  }

  // ---- obstruction (furniture / debris pile / parked vehicle) ----
  obstruct(module: StructuralModule, cell: number, tick: number): void {
    const d = this.record(module.id, cell);
    d.obstructed = true;
    this.deps.obstructCell?.(module.id, cell, this.settings.obstructionNavCost);
    this.structureModified(module.id, cell);
    this.emitSound(module.id, cell, tick);
  }

  clearObstruction(module: StructuralModule, cell: number, tick: number): void {
    const d = this.record(module.id, cell);
    d.obstructed = false;
    this.deps.clearObstruction?.(module.id, cell);
    this.structureModified(module.id, cell);
    this.emitSound(module.id, cell, tick);
  }

  // ---- utility work (power / circuits / water / alarms) ----
  cutPower(module: StructuralModule, cell: number, tick: number): void {
    this.structureModified(module.id, cell);
    this.emitSound(module.id, cell, tick, 'impact', this.settings.modificationSoundIntensity * 0.5);
  }

  restorePower(module: StructuralModule, cell: number, tick: number): void {
    this.structureModified(module.id, cell);
    this.emitSound(module.id, cell, tick, 'impact', this.settings.modificationSoundIntensity * 0.5);
  }

  silenceAlarm(module: StructuralModule, cell: number): void {
    // silencing an alarm is a quiet act — record the change, no loud stimulus.
    this.structureModified(module.id, cell);
  }

  /** Adapter exposing the modifier as StructuralHooks for breach/support paths. */
  private structuralHooks(): StructuralHooks {
    return {
      nextEventId: () => this.deps.ids.next<EventId>('event'),
      emit: (e) => this.emitWorld(e),
      openCell: (module, cell) => this.deps.openCell?.(module, cell),
    };
  }

  /**
   * Apply a frozen modifyStructure command (StructureOp subset). Obstruction / support-damage /
   * utility are richer than the command enum and are driven via the direct methods above.
   */
  apply(command: Command & { kind: 'modifyStructure' }, module: StructuralModule, tick: number): CommandResult {
    if ((module.id as number) !== (command.module as number)) {
      return { ok: false, id: command.id, reason: 'module-mismatch' };
    }
    const op: StructureOp = command.op;
    try {
      switch (op) {
        case 'open': this.open(module, command.cell, tick); break;
        case 'close': this.close(module, command.cell, tick); break;
        case 'lock': this.lock(module, command.cell, tick); break;
        case 'unlock': this.unlock(module, command.cell, tick); break;
        case 'board': this.board(module, command.cell, tick); break;
        case 'reinforce': this.reinforce(module, command.cell, tick); break;
        case 'breach': this.breach(module, command.cell, tick); break;
      }
    } catch (e) {
      return { ok: false, id: command.id, reason: (e as Error).message };
    }
    return { ok: true, id: command.id };
  }
}
