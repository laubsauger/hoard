// T40 / §G — the DECISIVE HORDE EVENT, shaped by the player's accumulated structural modifications.
// This is the central promise made mechanical: the same climax plays out DIFFERENTLY depending on what
// the player physically changed about the city. It is NOT a scripted fixed wave — its routes, pressure
// and outcome are computed from the live structural state (which connecting cells are breached open,
// which were reinforced/boarded, which are on fire) plus the horde mass pressing on the district.
//
//   - A BREACH opens a route the mass floods through (high pressure).
//   - A REINFORCED/boarded cell stalls the mass at that point (ambient pressure cut by reinforceStallFactor).
//   - FIRE on a route reroutes the mass away from it (pressure cut by fireRerouteFactor).
//
// Pure logic, no GPU, no per-frame state. `evaluateHordeEvent` is deterministic so the branching is
// directly testable; `HordeEvent` adds the announce->buildup->climax lifecycle the runtime drives. Every
// weight comes from typed config (V4).

import { resolveDomain } from '@/config/registry';
import { hordesConfig } from '@/config/domains/hordes';
import type { QualityTier } from '@/config/types';
import type { StructuralModule } from '@/game/destruction';

/** One connecting route the horde could use, in the state the PLAYER left it. */
export interface RouteState {
  readonly id: number;
  /** Breached open — the mass can pour through (the player, or the horde, opened it). */
  readonly open: boolean;
  /** Reinforced/boarded above base strength — stalls the mass at this point. */
  readonly reinforced: boolean;
  /** On fire — reroutes/stalls the mass away from this route. */
  readonly burning: boolean;
}

export interface HordeEventInput {
  /** Connecting routes, in their current player-shaped state. */
  readonly routes: readonly RouteState[];
  /** Total horde mass bearing on the district (live + abstract). */
  readonly hordeSize: number;
  /** Mass at/above which pressure saturates (1.0 horde factor). Below it, pressure scales down. */
  readonly referenceHordeSize: number;
}

export type HordeEventOutcome = 'contained' | 'overrun';

export interface RoutePressure {
  readonly id: number;
  /** Normalized 0..1 pressure on this route. */
  readonly pressure: number;
  /** Whether the mass actively flows THROUGH this route (an open, not-burning breach). */
  readonly flows: boolean;
}

export interface HordeEventResult {
  /** Normalized 0..1 aggregate pressure on the district at climax. */
  readonly totalPressure: number;
  readonly routePressures: readonly RoutePressure[];
  /** The route carrying the most pressure (where the mass concentrates), or -1 if none. */
  readonly dominantRouteId: number;
  /** contained = defenses held / mass rerouted; overrun = the mass flooded through. */
  readonly outcome: HordeEventOutcome;
  readonly openRouteCount: number;
  readonly reinforcedRouteCount: number;
}

export interface HordeEventSettings {
  readonly climaxPressureThreshold: number;
  readonly breachRouteWeight: number;
  readonly reinforceStallFactor: number;
  readonly fireRerouteFactor: number;
  readonly baseRoutePressure: number;
  readonly buildupTicks: number;
}

export function resolveHordeEventSettings(tier: QualityTier): HordeEventSettings {
  const h = resolveDomain(hordesConfig, tier);
  return {
    climaxPressureThreshold: h.climaxPressureThreshold,
    breachRouteWeight: h.breachRouteWeight,
    reinforceStallFactor: h.reinforceStallFactor,
    fireRerouteFactor: h.fireRerouteFactor,
    baseRoutePressure: h.baseRoutePressure,
    buildupTicks: h.eventBuildupTicks,
  };
}

/** Pressure a single route contributes, before horde-mass scaling (already normalized 0..1). */
function routePressure(r: RouteState, s: HordeEventSettings): number {
  if (r.open) {
    // The mass pours through a breach at full weight — unless fire on the breach reroutes it away.
    return s.breachRouteWeight * (r.burning ? s.fireRerouteFactor : 1);
  }
  // Intact route: only ambient pressing pressure. Reinforcement stalls it; fire pushes the mass away.
  let p = s.baseRoutePressure;
  if (r.reinforced) p *= s.reinforceStallFactor;
  if (r.burning) p *= s.fireRerouteFactor;
  return p;
}

/**
 * Resolve the decisive event from the current player-shaped structural state. Deterministic: identical
 * input always yields identical output, so the "same event, different outcome" promise is testable.
 */
export function evaluateHordeEvent(input: HordeEventInput, s: HordeEventSettings): HordeEventResult {
  if (input.referenceHordeSize <= 0) throw new Error(`referenceHordeSize must be positive, got ${input.referenceHordeSize}`);
  if (input.hordeSize < 0) throw new Error(`hordeSize must be non-negative, got ${input.hordeSize}`);

  const hordeFactor = Math.min(1, input.hordeSize / input.referenceHordeSize);

  const routePressures: RoutePressure[] = [];
  let sum = 0;
  let dominantRouteId = -1;
  let dominantPressure = -1;
  let openRouteCount = 0;
  let reinforcedRouteCount = 0;

  for (const r of input.routes) {
    if (r.open) openRouteCount += 1;
    if (r.reinforced) reinforcedRouteCount += 1;
    const p = routePressure(r, s);
    const flows = r.open && !r.burning;
    routePressures.push({ id: r.id, pressure: p, flows });
    sum += p;
    if (p > dominantPressure) {
      dominantPressure = p;
      dominantRouteId = r.id;
    }
  }

  // Average per-route pressure (so adding intact routes never inflates the total), scaled by horde mass.
  const avg = input.routes.length > 0 ? sum / input.routes.length : 0;
  const totalPressure = Math.min(1, avg * hordeFactor);
  const outcome: HordeEventOutcome = totalPressure >= s.climaxPressureThreshold ? 'overrun' : 'contained';

  return {
    totalPressure,
    routePressures,
    dominantRouteId,
    outcome,
    openRouteCount,
    reinforcedRouteCount,
  };
}

/**
 * Derive route states directly from a destructible StructuralModule's per-cell state (the player-shaped
 * truth). A cell is `open` when breached; `reinforced` when its current strength exceeds its base
 * maxStrength (board/reinforce added a buffer); `burning` per the supplied predicate (fire system state).
 */
export function routeStatesFromModule(
  module: StructuralModule,
  opts: { cellCount: number; packCell: (z: number) => number; isBurning?: (cell: number) => boolean },
): RouteState[] {
  const routes: RouteState[] = [];
  for (let z = 0; z < opts.cellCount; z++) {
    const cell = opts.packCell(z);
    const c = module.getCell(cell);
    const open = module.isBreached(cell);
    const reinforced = !open && c !== undefined && c.strength > c.maxStrength;
    const burning = opts.isBurning ? opts.isBurning(cell) : false;
    routes.push({ id: cell, open, reinforced, burning });
  }
  return routes;
}

/** Lifecycle phases of the decisive event. */
export type HordeEventPhase = 'idle' | 'building' | 'resolved';

/**
 * The decisive-event lifecycle the runtime drives. `arm(now)` announces the event; it builds for
 * buildupTicks (the window in which the player's last-minute fortifications still count), then `resolve`
 * snapshots the CURRENT structural state into a final outcome. The outcome is whatever the player made it.
 */
export class HordeEvent {
  private phase: HordeEventPhase = 'idle';
  private climaxTick = -1;
  private result: HordeEventResult | null = null;

  constructor(private readonly settings: HordeEventSettings) {}

  get currentPhase(): HordeEventPhase {
    return this.phase;
  }

  get climaxAtTick(): number {
    return this.climaxTick;
  }

  /** Announce the event; it will climax buildupTicks from `now`. Idempotent while already building. */
  arm(now: number): void {
    if (this.phase !== 'idle') return;
    this.phase = 'building';
    this.climaxTick = now + this.settings.buildupTicks;
  }

  /** Normalized 0..1 buildup progress toward climax (0 = just armed, 1 = at climax). */
  buildupProgress(now: number): number {
    if (this.phase === 'idle') return 0;
    if (this.phase === 'resolved') return 1;
    const elapsed = now - (this.climaxTick - this.settings.buildupTicks);
    return Math.min(1, Math.max(0, elapsed / this.settings.buildupTicks));
  }

  /** True on/after the climax tick while still building (the runtime should resolve now). */
  shouldResolve(now: number): boolean {
    return this.phase === 'building' && now >= this.climaxTick;
  }

  /** Evaluate against the current state WITHOUT resolving (diagnostics/HUD preview). Pure, no phase change. */
  peek(input: HordeEventInput): HordeEventResult {
    return evaluateHordeEvent(input, this.settings);
  }

  /** Resolve the climax against the live, player-shaped state. Terminal. Returns the final result. */
  resolve(input: HordeEventInput): HordeEventResult {
    const result = evaluateHordeEvent(input, this.settings);
    this.result = result;
    this.phase = 'resolved';
    return result;
  }

  /** The final result, or null until resolved. */
  get resolvedResult(): HordeEventResult | null {
    return this.result;
  }
}
