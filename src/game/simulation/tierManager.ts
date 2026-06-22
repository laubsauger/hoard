// T10 / V13 — tiered population manager.
// Assigns sim + render tier from gameplay inputs (distance, visibility, threat, camera importance,
// target status, recent damage, current attack, available perf budget). Promotion/demotion writes
// ONLY the simTier/renderTier fields of a slot — because all other state (identity, health, anatomy,
// equipment, behaviour) lives at the same stable SoA slot, retiering can NEVER clear it (V13).

import { resolveDomain } from '@/config/registry';
import { zombiesConfig } from '@/config/domains/zombies';
import type { QualityTier, ResolvedDomain } from '@/config/types';
import type { SimulationZombies, ZombieSlot } from './zombieStore';

/** Sim tiers (mirrors the frozen SoA `simTier` field doc). Lower = more fidelity. */
export enum SimTier {
  Hero = 0,
  ActiveCrowd = 1,
  VisibleHorde = 2,
  Abstract = 3,
}

/** Inputs the tier policy reads. All gameplay-derived; never raw object refs (V26). */
export interface TierInputs {
  /** Metres from the camera/player focus. */
  readonly distance: number;
  /** Currently within the rendered/known view. */
  readonly visible: boolean;
  /** Threat level this zombie poses, 0..1. */
  readonly threat: number;
  /** Camera/composition importance, 0..1. */
  readonly cameraImportance: number;
  /** The player has this zombie selected as a target. */
  readonly targeted: boolean;
  /** Took damage within the recent window (must resolve hit response at fidelity). */
  readonly recentDamage: boolean;
  /** Mid-attack animation that must play out authoritatively. */
  readonly currentAttack: boolean;
  /** Available perf budget, 0..1 (low = suppress discretionary promotions). */
  readonly perfBudget: number;
}

export interface TierAssignment {
  readonly simTier: SimTier;
  readonly renderTier: SimTier;
}

type ZombiesSettings = ResolvedDomain<typeof zombiesConfig>;

const REFERENCE_TIER: QualityTier = 'desktop-high';

export class TierManager {
  private readonly cfg: ZombiesSettings;

  constructor(tier: QualityTier = REFERENCE_TIER) {
    this.cfg = resolveDomain(zombiesConfig, tier);
  }

  /** Pure tier policy — deterministic function of inputs + config. No side effects. */
  assign(input: TierInputs): TierAssignment {
    if (input.distance < 0 || Number.isNaN(input.distance)) {
      throw new Error(`tier distance must be a non-negative number, got ${input.distance}`);
    }
    this.assertUnit('threat', input.threat);
    this.assertUnit('cameraImportance', input.cameraImportance);
    this.assertUnit('perfBudget', input.perfBudget);

    // 1. Base tier from distance bands.
    let sim: SimTier;
    if (input.distance <= this.cfg.heroDistance) sim = SimTier.Hero;
    else if (input.distance <= this.cfg.activeDistance) sim = SimTier.ActiveCrowd;
    else if (input.distance <= this.cfg.hordeDistance) sim = SimTier.VisibleHorde;
    else sim = SimTier.Abstract;

    // 2. Mandatory promotions — authoritative correctness must not be hidden by a render budget (V22).
    // A targeted / mid-attack / recently-damaged zombie is promoted to hero so its hit response,
    // anatomy and attack resolve at full fidelity even at distance (V13).
    if (input.targeted || input.currentAttack || input.recentDamage) {
      sim = SimTier.Hero;
    } else {
      // 3. Discretionary promotions from threat + camera importance, one tier each, budget-gated.
      let promotions = 0;
      if (input.threat >= this.cfg.threatPromoteLevel) promotions += 1;
      if (input.cameraImportance >= this.cfg.cameraPromoteLevel) promotions += 1;
      if (promotions > 0 && input.perfBudget >= this.cfg.perfBudgetFloor) {
        sim = clampTier(sim - promotions);
      }
    }

    // 4. Render tier never exceeds sim fidelity, and an off-screen zombie renders no richer than
    //    abstract regardless of its sim tier (you cannot see it). Sim authority is unaffected.
    let render: SimTier = sim;
    if (!input.visible) render = SimTier.Abstract;

    return { simTier: sim, renderTier: render };
  }

  /**
   * Apply an assignment to a slot. Writes ONLY simTier + renderTier (V13).
   * Returns true when either tier actually changed (for diagnostics / dirty tracking).
   */
  apply(store: SimulationZombies, slot: ZombieSlot, assignment: TierAssignment): boolean {
    const changed =
      store.getSimTier(slot) !== assignment.simTier ||
      store.getRenderTier(slot) !== assignment.renderTier;
    store.setSimTier(slot, assignment.simTier);
    store.setRenderTier(slot, assignment.renderTier);
    return changed;
  }

  /** Convenience: assign + apply in one step. */
  update(store: SimulationZombies, slot: ZombieSlot, input: TierInputs): TierAssignment {
    const assignment = this.assign(input);
    this.apply(store, slot, assignment);
    return assignment;
  }

  private assertUnit(name: string, v: number): void {
    if (Number.isNaN(v) || v < 0 || v > 1) {
      throw new Error(`tier input '${name}' must be in [0,1], got ${v}`);
    }
  }
}

function clampTier(t: number): SimTier {
  if (t < SimTier.Hero) return SimTier.Hero;
  if (t > SimTier.Abstract) return SimTier.Abstract;
  return t as SimTier;
}
