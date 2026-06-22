// T18 / V16 / V28 — weapons: melee sweep + firearm with ammo, line-of-fire penetration and sound.
// The WeaponSystem composes the CombatSystem resolution core (T16) with weapon-level concerns:
//   - ammo (a firearm cannot fire empty — no silent infinite ammo)
//   - line-of-fire penetration (CombatSystem.firePenetrating)
//   - the timed melee attack-volume window (MeleeSwing — V16)
//   - a SOUND stimulus emitted on every shot/strike (V28: a heard event also produces a stimulus
//     that behaviour consumes; this is exactly how gunfire attracts a horde).
// Sound emission requires a StimulusField + an id source — they are injected, never optional, so a
// fired weapon ALWAYS produces its acoustic stimulus (no brittle "skip sound" fallback).

import type { Stimulus, StimulusId } from '@/game/core/contracts';
import type { StimulusField } from '@/game/stimulus';
import { SimTier } from '@/game/simulation';
import type { ResolvedDomain } from '@/config/types';
import type { weaponsConfig } from '@/config/domains/weapons';
import type { combatConfig } from '@/config/domains/combat';
import type { AnatomyRegion } from '@/game/core/contracts';
import type { CombatSystem, ShotOrigin, ShotResult } from './hitPath';
import { MeleeSwing } from './attackWindow';

/** Ammunition for a single firearm. Bounded magazine; firing empty fails explicitly. */
export class Magazine {
  private _rounds: number;
  constructor(readonly capacity: number, rounds = capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`magazine capacity must be a positive integer, got ${capacity}`);
    }
    if (!Number.isInteger(rounds) || rounds < 0 || rounds > capacity) {
      throw new Error(`magazine rounds must be an integer in [0, ${capacity}], got ${rounds}`);
    }
    this._rounds = rounds;
  }
  get rounds(): number {
    return this._rounds;
  }
  get empty(): boolean {
    return this._rounds === 0;
  }
  /** Consume one round. Returns false when empty (caller must not fire). */
  consume(): boolean {
    if (this._rounds === 0) return false;
    this._rounds -= 1;
    return true;
  }
  reload(): void {
    this._rounds = this.capacity;
  }
}

export interface WeaponDeps {
  readonly combat: CombatSystem;
  readonly stimulus: StimulusField;
  readonly weapons: ResolvedDomain<typeof weaponsConfig>;
  readonly combatCfg: ResolvedDomain<typeof combatConfig>;
  /** Deterministic StimulusId source (V26). */
  readonly nextStimulusId: () => StimulusId;
  /** Current authoritative tick — sound stimuli are stamped with it. */
  readonly nowTick: () => number;
}

export interface FireOutcome {
  readonly fired: boolean;
  /** Reason when `fired` is false (e.g. 'empty'). */
  readonly reason?: string;
  readonly shots: ShotResult[];
  readonly soundId?: StimulusId;
  readonly ammoRemaining: number;
}

export interface MeleeOutcome {
  readonly resolved: boolean;
  readonly phase: ReturnType<MeleeSwing['phase']>;
  readonly shots: ShotResult[];
  readonly soundId?: StimulusId;
}

export class WeaponSystem {
  readonly magazine: Magazine;
  private readonly swing: MeleeSwing;

  constructor(private readonly deps: WeaponDeps) {
    this.magazine = new Magazine(deps.weapons.firearmMagazineSize);
    this.swing = new MeleeSwing({
      windupTicks: deps.combatCfg.meleeWindupTicks,
      activeTicks: deps.combatCfg.meleeActiveWindowTicks,
      recoverTicks: deps.combatCfg.meleeRecoverTicks,
    });
  }

  // ---- firearm ----

  /** Fire one penetrating shot: consume a round, resolve the line of fire, emit a gunfire sound. */
  fireFirearm(
    origin: ShotOrigin,
    dirX: number,
    dirZ: number,
    region: AnatomyRegion,
    opts: { tierOverride?: SimTier; severScale?: number } = {},
  ): FireOutcome {
    if (!this.magazine.consume()) {
      return { fired: false, reason: 'empty', shots: [], ammoRemaining: 0 };
    }
    const shots = this.deps.combat.firePenetrating(origin, dirX, dirZ, region, opts);
    const soundId = this.emitSound(
      origin.x,
      origin.z,
      'gunfire',
      this.deps.weapons.gunfireSoundIntensity,
      this.deps.weapons.gunfireSoundRadiusMeters,
    );
    return { fired: true, shots, soundId, ammoRemaining: this.magazine.rounds };
  }

  reload(): void {
    this.magazine.reload();
  }

  // ---- melee (timed attack-volume window, V16) ----

  /** Begin a melee swing in (dirX,dirZ) at `tick`. Damage only resolves during the active window. */
  startSwing(tick: number, dirX: number, dirZ: number): void {
    this.swing.start(tick, dirX, dirZ);
  }

  swingPhase(tick: number): ReturnType<MeleeSwing['phase']> {
    return this.swing.phase(tick);
  }

  /**
   * Advance the swing at `tick`. Resolves the sweep + emits a sound ONCE, only during the active
   * window (V16). Outside the active window this never deals damage — windup/recover/idle = no-op.
   */
  updateSwing(
    tick: number,
    origin: ShotOrigin,
    region: AnatomyRegion,
    opts: { tierOverride?: SimTier; severScale?: number } = {},
  ): MeleeOutcome {
    const phase = this.swing.phase(tick);
    if (!this.swing.tryConsume(tick)) {
      return { resolved: false, phase, shots: [] };
    }
    const shots = this.deps.combat.meleeSweep(
      origin,
      this.swing.swingDirX,
      this.swing.swingDirZ,
      region,
      opts,
    );
    const soundId = this.emitSound(
      origin.x,
      origin.z,
      'impact',
      this.deps.weapons.meleeSoundIntensity,
      this.deps.weapons.meleeSoundRadiusMeters,
    );
    return { resolved: true, phase, shots, soundId };
  }

  // ---- sound (V28) ----

  private emitSound(
    x: number,
    z: number,
    source: 'gunfire' | 'impact',
    intensity: number,
    radius: number,
  ): StimulusId {
    const tick = this.deps.nowTick();
    const id = this.deps.nextStimulusId();
    const stimulus: Stimulus = {
      id,
      kind: 'sound',
      source,
      x,
      z,
      intensity,
      radius,
      bornTick: tick,
      decayPerTick: this.deps.weapons.weaponSoundDecayPerTick,
    };
    // bounded field; an evicted weak stimulus is acceptable (it lost the salience contest, not a drop bug).
    this.deps.stimulus.emit(stimulus, tick);
    return id;
  }
}
