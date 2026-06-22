// T16 / V16 — timed melee attack-volume window.
// V16: player attack damage applies ONLY through a timed attack volume tied to the animation — never
// from navigation overlap. A swing runs windup → active → recover. The damage volume exists ONLY
// during the active phase, and resolves exactly ONCE per swing. This state machine is the gate the
// WeaponSystem checks before calling CombatSystem.meleeSweep.

export type SwingPhase = 'idle' | 'windup' | 'active' | 'recover';

export interface SwingConfig {
  readonly windupTicks: number;
  readonly activeTicks: number;
  readonly recoverTicks: number;
}

export class MeleeSwing {
  private startTick = -1;
  private resolved = false;
  readonly dirX: number = 1;
  readonly dirZ: number = 0;
  private _dirX = 1;
  private _dirZ = 0;

  constructor(private readonly cfg: SwingConfig) {
    if (cfg.windupTicks < 0 || cfg.activeTicks <= 0 || cfg.recoverTicks < 0) {
      throw new Error('swing config requires windupTicks>=0, activeTicks>0, recoverTicks>=0');
    }
  }

  get swingDirX(): number {
    return this._dirX;
  }
  get swingDirZ(): number {
    return this._dirZ;
  }

  /** Begin a swing at `tick`. Throws if a swing is still in progress (no overlapping swings). */
  start(tick: number, dirX: number, dirZ: number): void {
    if (this.startTick >= 0 && this.phase(tick) !== 'idle') {
      throw new Error('cannot start a swing while another is in progress');
    }
    const len = Math.hypot(dirX, dirZ);
    if (len === 0) throw new Error('swing direction must be non-zero in the xz plane');
    this.startTick = tick;
    this.resolved = false;
    this._dirX = dirX / len;
    this._dirZ = dirZ / len;
  }

  /** Phase at `tick`. */
  phase(tick: number): SwingPhase {
    if (this.startTick < 0) return 'idle';
    const e = tick - this.startTick;
    if (e < 0) return 'idle';
    if (e < this.cfg.windupTicks) return 'windup';
    if (e < this.cfg.windupTicks + this.cfg.activeTicks) return 'active';
    if (e < this.cfg.windupTicks + this.cfg.activeTicks + this.cfg.recoverTicks) return 'recover';
    return 'idle';
  }

  /** True while the damage volume is open. */
  isActive(tick: number): boolean {
    return this.phase(tick) === 'active';
  }

  /**
   * Consume the single damage resolution for this swing. Returns true at most once per swing, and
   * ONLY during the active window — windup/recover/idle never deal damage (V16).
   */
  tryConsume(tick: number): boolean {
    if (this.resolved) return false;
    if (!this.isActive(tick)) return false;
    this.resolved = true;
    return true;
  }
}
