// T22 / V31 — survival systems. SLOW pressure, never constant meter babysitting.
// Hunger/thirst, fatigue/sleep (quality depends on security/pain/noise/temp), bleeding/pain (persist,
// readable severity), infection risk (consistent rules surfaced via symptoms), encumbrance (set by the
// inventory system), stress/panic (degrade control/awareness, NEVER remove agency). Competence raises
// reliability (slower decay, better sleep), NOT superhuman damage. Produces a PlayerViewSnapshot
// (frozen contract) for the HUD — this system does NOT touch any store (V1).

import { resolveDomain } from '@/config/registry';
import { survivalConfig } from '@/config/domains/survival';
import type { QualityTier, ResolvedDomain } from '@/config/types';
import type { EntityId, PlayerViewSnapshot } from '@/game/core/contracts';

export type SurvivalSettings = ResolvedDomain<typeof survivalConfig>;

const REFERENCE_TIER: QualityTier = 'desktop-high';

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function assertUnit(name: string, v: number): void {
  if (Number.isNaN(v) || v < 0 || v > 1) {
    throw new Error(`survival input '${name}' must be in [0,1], got ${v}`);
  }
}

/** Mutable authoritative survival condition. All meters are normalized 0..1. */
export interface SurvivalState {
  health: number;
  hunger: number;
  thirst: number;
  fatigue: number;
  /** Active bleeding severity (acute — drains health fast until clotted/treated). */
  bleeding: number;
  pain: number;
  /** Infection progress; surfaces as symptoms (extra pain + fatigue) past a threshold. */
  infection: number;
  stress: number;
  /** Set by the inventory system each tick (weight + quick-access cost). */
  encumbrance: number;
  /** Count of untreated open wounds driving infection risk. */
  openWounds: number;
  /** Progression 0..1 — more reliability, not more damage. */
  competence: number;
}

/** Per-update environment the survival system reads (stimulus-derived, never omniscient). */
export interface SurvivalEnv {
  /** Elapsed in-game seconds since last update. */
  readonly seconds: number;
  /** Perceived threat intensity 0..1 (from perception/horde pressure). */
  readonly threat: number;
  /** Ambient noise 0..1 (from the audio sim). */
  readonly noise: number;
  /** Current encumbrance 0..1 from the inventory system. */
  readonly encumbrance: number;
}

/** Conditions a sleep attempt happens under (V31 — quality depends on these). */
export interface SleepConditions {
  readonly hours: number;
  readonly security: number;
  readonly noise: number;
  readonly tempDiscomfort: number;
}

export interface SleepResult {
  readonly quality: number;
  readonly fatigueRecovered: number;
}

function defaultState(competence: number): SurvivalState {
  return {
    health: 1, hunger: 0, thirst: 0, fatigue: 0, bleeding: 0, pain: 0,
    infection: 0, stress: 0, encumbrance: 0, openWounds: 0, competence,
  };
}

export interface SurvivalOptions {
  readonly entity: EntityId;
  readonly tier?: QualityTier;
  readonly competence?: number;
  readonly initial?: Partial<SurvivalState>;
}

export class SurvivalSystem {
  readonly entity: EntityId;
  readonly settings: SurvivalSettings;
  private readonly s: SurvivalState;

  constructor(opts: SurvivalOptions) {
    const competence = opts.competence ?? 0;
    if (competence < 0 || competence > 1) throw new Error(`competence must be in [0,1], got ${competence}`);
    this.entity = opts.entity;
    this.settings = resolveDomain(survivalConfig, opts.tier ?? REFERENCE_TIER);
    this.s = { ...defaultState(competence), ...opts.initial };
  }

  get state(): Readonly<SurvivalState> {
    return this.s;
  }

  get alive(): boolean {
    return this.s.health > 0;
  }

  /** Infection has crossed the symptom threshold (fever surfaces — V31 communicated via symptoms). */
  get infectionSymptomatic(): boolean {
    return this.s.infection >= this.settings.infectionSymptomThreshold;
  }

  /** Panic flagged — degrades control/awareness elsewhere; never removes agency (V31). */
  get panicking(): boolean {
    return this.s.stress >= this.settings.panicStressThreshold;
  }

  /** Competence reduces hunger/thirst/fatigue decay (reliability, not power). */
  private decayFactor(): number {
    return 1 - this.s.competence * this.settings.competenceDecayReductionMax;
  }

  /** Add a wound: raises bleeding severity; an open wound also drives infection risk. */
  wound(severity: number, open = true): void {
    assertUnit('wound severity', severity);
    this.s.bleeding = clamp01(this.s.bleeding + severity);
    if (open) this.s.openWounds += 1;
  }

  /** Treat wounds: clot bleeding, close ONE open wound, knock back infection. */
  treatWound(effectiveness: number): void {
    assertUnit('treatment effectiveness', effectiveness);
    this.s.bleeding = clamp01(this.s.bleeding - effectiveness);
    this.s.infection = clamp01(this.s.infection - effectiveness * 0.5);
    this.s.openWounds = Math.max(0, this.s.openWounds - 1);
  }

  eat(amount: number): void {
    assertUnit('eat amount', amount);
    this.s.hunger = clamp01(this.s.hunger - amount);
  }

  drink(amount: number): void {
    assertUnit('drink amount', amount);
    this.s.thirst = clamp01(this.s.thirst - amount);
  }

  /** Heal directly (medicine). */
  heal(amount: number): void {
    assertUnit('heal amount', amount);
    this.s.health = clamp01(this.s.health + amount);
  }

  setCompetence(v: number): void {
    assertUnit('competence', v);
    this.s.competence = v;
  }

  /**
   * Sleep. Quality scales with security and is reduced by pain/noise/temperature (V31). Competence
   * grants a settling-in bonus. Recovery = hours * perfect-rate * quality. Returns the outcome.
   */
  sleep(c: SleepConditions): SleepResult {
    if (c.hours < 0 || Number.isNaN(c.hours)) throw new Error(`sleep hours must be >= 0, got ${c.hours}`);
    assertUnit('security', c.security);
    assertUnit('sleep noise', c.noise);
    assertUnit('temp discomfort', c.tempDiscomfort);
    const cfg = this.settings;
    let quality = (c.security === 1 ? 1 : 1 - cfg.sleepSecurityWeight * (1 - c.security))
      * (1 - cfg.sleepPainWeight * this.s.pain)
      * (1 - cfg.sleepNoiseWeight * c.noise)
      * (1 - cfg.sleepTempWeight * c.tempDiscomfort);
    quality = clamp01(quality);
    // competence settles you in: closes part of the remaining quality gap.
    quality = clamp01(quality + this.s.competence * cfg.competenceSleepQualityBonusMax * (1 - quality));
    const before = this.s.fatigue;
    this.s.fatigue = clamp01(this.s.fatigue - c.hours * cfg.sleepRecoveryPerHour * quality);
    // rest also bleeds off stress proportional to quality.
    this.s.stress = clamp01(this.s.stress - c.hours * cfg.stressDecayPerSec * 3600 * quality);
    return { quality, fatigueRecovered: before - this.s.fatigue };
  }

  /** Advance the slow pressure by `env.seconds` in-game seconds. */
  update(env: SurvivalEnv): void {
    if (env.seconds < 0 || Number.isNaN(env.seconds)) throw new Error(`seconds must be >= 0, got ${env.seconds}`);
    assertUnit('threat', env.threat);
    assertUnit('noise', env.noise);
    assertUnit('encumbrance', env.encumbrance);
    const dt = env.seconds;
    const cfg = this.settings;
    const s = this.s;
    const decay = this.decayFactor();

    s.encumbrance = env.encumbrance;

    // ---- needs accrue slowly (encumbrance makes you burn fatigue faster) ----
    s.hunger = clamp01(s.hunger + cfg.hungerRatePerSec * decay * dt);
    s.thirst = clamp01(s.thirst + cfg.thirstRatePerSec * decay * dt);
    s.fatigue = clamp01(s.fatigue + cfg.fatigueRatePerSec * decay * (1 + env.encumbrance) * dt);

    // ---- starvation / dehydration only bite once maxed ----
    if (s.hunger >= 1) s.health = clamp01(s.health - cfg.starvationHealthLossPerSec * dt);
    if (s.thirst >= 1) s.health = clamp01(s.health - cfg.dehydrationHealthLossPerSec * dt);

    // ---- bleeding: acute health drain; clots slowly when untreated (the wound stays OPEN until
    // treated — clotting stops blood loss, it does not disinfect) ----
    if (s.bleeding > 0) {
      s.health = clamp01(s.health - cfg.bleedHealthLossPerSec * s.bleeding * dt);
      s.bleeding = clamp01(s.bleeding - cfg.bleedClotPerSec * dt);
    }

    // ---- infection: consistent rule (per open wound) surfaced via symptoms ----
    if (s.openWounds > 0) {
      s.infection = clamp01(s.infection + cfg.infectionRiskPerSec * s.openWounds * dt);
    }
    const symptomatic = s.infection >= cfg.infectionSymptomThreshold;

    // ---- pain tends toward its bleed+infection floor, fading otherwise ----
    const painFloor = clamp01(s.bleeding * cfg.painFromBleed + (symptomatic ? s.infection * cfg.painFromBleed : 0));
    if (symptomatic) s.pain = clamp01(s.pain + cfg.infectionSymptomPain * dt);
    if (s.pain > painFloor) s.pain = Math.max(painFloor, s.pain - cfg.painDecayPerSec * dt);
    else s.pain = painFloor;

    // infection fever also adds fatigue.
    if (symptomatic) s.fatigue = clamp01(s.fatigue + cfg.infectionSymptomPain * dt);

    // ---- stress: threat + pain push up, safety bleeds it off; panic is a flag, not a lockout ----
    const stressIn = (cfg.stressFromThreatPerSec * env.threat + cfg.stressFromPain * s.pain
      + cfg.stressFromThreatPerSec * env.noise * 0.5) * dt;
    s.stress = clamp01(s.stress + stressIn);
    if (env.threat === 0) s.stress = clamp01(s.stress - cfg.stressDecayPerSec * dt);
  }

  /** Throttled HUD readout (V1/V11) — the snapshot is the only thing React sees. */
  snapshot(): PlayerViewSnapshot {
    const s = this.s;
    return {
      entity: this.entity,
      health: s.health,
      bleeding: s.bleeding,
      pain: s.pain,
      hunger: s.hunger,
      thirst: s.thirst,
      fatigue: s.fatigue,
      stress: s.stress,
      encumbrance: s.encumbrance,
    };
  }
}
