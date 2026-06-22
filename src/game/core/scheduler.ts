// T3 / V12 — system scheduler with frequency buckets.
// Subsystems run at tier-appropriate cadences (handout "System scheduling"):
//   everyTick / every 2-4 / every 5-15 / per-second-or-event / on-demand.
// Order of authoritative changes stays explicit + testable: systems run in registration order.

export type Cadence =
  | { readonly bucket: 'everyTick' }
  | { readonly bucket: 'interval'; readonly everyTicks: number }
  | { readonly bucket: 'onDemand' };

export interface SystemContext {
  /** Current authoritative tick index. */
  readonly tick: number;
  /** Fixed seconds per tick. */
  readonly tickSeconds: number;
}

export type SystemFn = (ctx: SystemContext) => void;

interface RegisteredSystem {
  readonly name: string;
  readonly cadence: Cadence;
  readonly phase: number;
  readonly fn: SystemFn;
}

export class SystemScheduler {
  private readonly systems: RegisteredSystem[] = [];
  private readonly names = new Set<string>();

  /**
   * Register a system. `interval` cadence runs when (tick % everyTicks) === phase, so multiple
   * interval systems can be spread across ticks to flatten per-tick cost. `onDemand` never auto-runs.
   */
  register(name: string, cadence: Cadence, fn: SystemFn, phase = 0): void {
    if (this.names.has(name)) throw new Error(`system '${name}' already registered`);
    if (cadence.bucket === 'interval') {
      if (!Number.isInteger(cadence.everyTicks) || cadence.everyTicks < 1) {
        throw new Error(`system '${name}' interval everyTicks must be a positive integer`);
      }
      if (!Number.isInteger(phase) || phase < 0 || phase >= cadence.everyTicks) {
        throw new Error(`system '${name}' phase ${phase} out of range [0, ${cadence.everyTicks})`);
      }
    }
    this.names.add(name);
    this.systems.push({ name, cadence, phase, fn });
  }

  /** Run all due systems for a single tick, in registration order. */
  runTick(ctx: SystemContext): void {
    for (const s of this.systems) {
      if (this.isDue(s, ctx.tick)) s.fn(ctx);
    }
  }

  /** Run a single on-demand system by name (e.g. path request, structural edit). */
  runOnDemand(name: string, ctx: SystemContext): void {
    const s = this.systems.find((x) => x.name === name);
    if (!s) throw new Error(`unknown system '${name}'`);
    if (s.cadence.bucket !== 'onDemand') throw new Error(`system '${name}' is not on-demand`);
    s.fn(ctx);
  }

  private isDue(s: RegisteredSystem, tick: number): boolean {
    switch (s.cadence.bucket) {
      case 'everyTick': return true;
      case 'interval': return tick % s.cadence.everyTicks === s.phase;
      case 'onDemand': return false;
    }
  }

  registeredNames(): string[] {
    return this.systems.map((s) => s.name);
  }
}
