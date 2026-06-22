// T26 / V18 — fire system layered on the StructuralModule. Fire is COMPACT PERSISTENT STATE: a small
// map of burning cells (fuel + intensity), NOT thousands of particles or rigid bodies. A burning cell
//   - deals damage-over-time to its structural cell (can breach -> reuses the breach path, no rebuild),
//   - emits light + smoke (readouts for render/visibility),
//   - emits a `fire` Stimulus into the injected StimulusField (perception input + evacuation pressure),
//   - spreads probabilistically to adjacent flammable cells (deterministic via a seeded PRNG, V26),
//   - decays once fuel is exhausted (embers -> extinguish).
// Ignition also emits a `fireIgnited` WorldEvent (persists to the save delta).

import { resolveDomain } from '@/config/registry';
import { fireConfig } from '@/config/domains/fire';
import type { QualityTier, ResolvedDomain } from '@/config/types';
import type {
  EventId,
  ModuleId,
  Stimulus,
  StimulusId,
  WorldEvent,
} from '@/game/core/contracts';
import type { StimulusField } from '@/game/stimulus';
import type { IdFactory } from '@/game/core/ids';
import { StructuralModule, type Material, type StructuralHooks } from './structuralModule';

export type FireSettings = ResolvedDomain<typeof fireConfig>;

const REFERENCE_TIER: QualityTier = 'desktop-high';

/** Structural materials that catch fire from a neighbour on their own (classification, not a tunable). */
const FLAMMABLE: ReadonlySet<Material> = new Set<Material>(['wood']);

/** Compact per-cell fire state (V18). */
export interface BurningCell {
  readonly cell: number;
  fuel: number;
  /** 0..1 — climbs as it catches, falls during burnout. */
  intensity: number;
  burning: boolean;
}

/** Deterministic PRNG (mulberry32) so spread replays identically for a seed (V26). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FireDeps {
  readonly ids: IdFactory;
  readonly field: StimulusField;
  readonly emit: (event: WorldEvent) => void;
  readonly locate: (module: ModuleId, cell: number) => { x: number; z: number };
  /** LOCAL nav open when fire damage breaches a cell (V5). */
  readonly openCell?: (module: ModuleId, cell: number) => void;
  readonly seed?: number;
  readonly tier?: QualityTier;
}

export class FireSim {
  readonly settings: FireSettings;
  readonly module: StructuralModule;
  private readonly deps: FireDeps;
  private readonly rand: () => number;
  private readonly burning = new Map<number, BurningCell>();

  constructor(module: StructuralModule, deps: FireDeps) {
    this.module = module;
    this.deps = deps;
    this.settings = resolveDomain(fireConfig, deps.tier ?? REFERENCE_TIER);
    this.rand = mulberry32((deps.seed ?? 1) ^ (module.id as number));
  }

  get burningCount(): number {
    return this.burning.size;
  }

  isBurning(cell: number): boolean {
    return this.burning.get(cell)?.burning ?? false;
  }

  getBurning(cell: number): Readonly<BurningCell> | undefined {
    return this.burning.get(cell);
  }

  private flammable(cell: number): boolean {
    const c = this.module.getCell(cell);
    return c ? FLAMMABLE.has(c.material) : false;
  }

  /** Aggregate emitted light 0..1 (max over burning cells) — drives a dynamic local light. */
  get light(): number {
    let m = 0;
    for (const b of this.burning.values()) m = Math.max(m, b.intensity * this.settings.lightIntensity);
    return m;
  }

  /** Aggregate emitted smoke 0..1 — reduces visibility / drives evacuation. */
  get smoke(): number {
    let m = 0;
    for (const b of this.burning.values()) m = Math.max(m, b.intensity * this.settings.smokeIntensity);
    return m;
  }

  /**
   * Ignite a cell. By default only flammable structural materials catch; pass `fuel` to ignite a
   * non-structural fuel source (fabric furniture, vegetation, spilled fuel) occupying the cell.
   */
  ignite(cell: number, tick: number, fuel?: number): boolean {
    if (!this.module.getCell(cell)) throw new Error(`cannot ignite empty cell ${cell}`);
    if (this.burning.has(cell)) return false;
    if (fuel === undefined && !this.flammable(cell)) return false;
    if (fuel !== undefined && (fuel <= 0 || Number.isNaN(fuel))) throw new Error(`ignite fuel must be > 0, got ${fuel}`);
    this.burning.set(cell, { cell, fuel: fuel ?? this.settings.ignitionFuel, intensity: 0.2, burning: true });
    this.deps.emit({ kind: 'fireIgnited', id: this.deps.ids.next<EventId>('event'), module: this.module.id, cell });
    this.emitFireStimulus(cell, tick);
    return true;
  }

  private emitFireStimulus(cell: number, tick: number, intensityScale = 1): void {
    const { x, z } = this.deps.locate(this.module.id, cell);
    const id = this.deps.ids.next<StimulusId>('stimulus');
    const stim: Stimulus = {
      id,
      kind: 'fire',
      source: 'fire',
      x,
      z,
      intensity: this.settings.stimulusIntensity * intensityScale,
      radius: this.settings.stimulusRadiusMeters,
      bornTick: tick,
      decayPerTick: this.settings.stimulusDecayPerTick,
    };
    this.deps.field.emit(stim, tick);
  }

  private structuralHooks(): StructuralHooks {
    return {
      nextEventId: () => this.deps.ids.next<EventId>('event'),
      emit: (e) => this.deps.emit(e),
      openCell: (module, cell) => this.deps.openCell?.(module, cell),
    };
  }

  /** Advance every burning cell by `seconds` in-game seconds. */
  update(seconds: number, tick: number): void {
    if (seconds < 0 || Number.isNaN(seconds)) throw new Error(`seconds must be >= 0, got ${seconds}`);
    if (this.burning.size === 0) return;
    const cfg = this.settings;
    const hooks = this.structuralHooks();

    // snapshot the set so spread within this step doesn't re-process newly-lit cells.
    const active = [...this.burning.values()];

    let sumX = 0;
    let sumZ = 0;
    let aliveCount = 0;
    let maxIntensity = 0;

    for (const b of active) {
      if (!b.burning) continue;
      if (b.fuel > 0) {
        // burning: consume fuel, climb intensity, deal structural DoT, maybe spread.
        b.fuel = Math.max(0, b.fuel - cfg.burnRatePerSec * seconds);
        b.intensity = Math.min(1, b.intensity + 0.5 * seconds);
        this.damageCell(b.cell, cfg.structuralDamagePerSec * b.intensity * seconds, hooks);
        this.trySpread(b, seconds, tick);
      } else {
        // burnout: embers fade + residual damage, then extinguish.
        b.intensity = Math.max(0, b.intensity - 0.5 * seconds);
        this.damageCell(b.cell, cfg.burnoutDamagePerSec * b.intensity * seconds, hooks);
        if (b.intensity <= 0) b.burning = false;
      }

      if (b.burning) {
        const { x, z } = this.deps.locate(this.module.id, b.cell);
        sumX += x;
        sumZ += z;
        aliveCount += 1;
        maxIntensity = Math.max(maxIntensity, b.intensity);
      } else {
        this.burning.delete(b.cell);
      }
    }

    // one aggregate fire Stimulus re-emitted at the centroid keeps perception/migration aware while it
    // burns (V28 persistent disturbance). A single record per step, not one per cell.
    if (aliveCount > 0) {
      const cx = sumX / aliveCount;
      const cz = sumZ / aliveCount;
      const id = this.deps.ids.next<StimulusId>('stimulus');
      this.deps.field.emit({
        id,
        kind: 'fire',
        source: 'fire',
        x: cx,
        z: cz,
        intensity: cfg.stimulusIntensity * maxIntensity,
        radius: cfg.stimulusRadiusMeters,
        bornTick: tick,
        decayPerTick: cfg.stimulusDecayPerTick,
      }, tick);
    }
  }

  private trySpread(b: BurningCell, seconds: number, tick: number): void {
    const cfg = this.settings;
    const radius = cfg.spreadRadiusCells;
    if (radius <= 0) return;
    const chance = Math.min(1, cfg.spreadChancePerSec * seconds * b.intensity);
    const { x, y, z } = this.module.unpackCell(b.cell);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (nx < 0 || ny < 0 || nz < 0 || nx >= this.module.sizeX || ny >= this.module.sizeY || nz >= this.module.sizeZ) continue;
          const ncell = nx + ny * this.module.sizeX + nz * this.module.sizeX * this.module.sizeY;
          if (this.burning.has(ncell)) continue;
          if (!this.flammable(ncell)) continue;
          if (this.rand() < chance) this.ignite(ncell, tick);
        }
      }
    }
  }

  private damageCell(cell: number, amount: number, hooks: StructuralHooks): void {
    if (amount <= 0) return;
    const c = this.module.getCell(cell);
    if (!c || c.breached) return;
    this.module.applyDamage(cell, amount, hooks);
  }

  // ---- compact persistence (V18) ----
  fireDelta(): BurningCell[] {
    return [...this.burning.values()].map((b) => ({ ...b }));
  }

  applyFireSnapshot(snapshot: readonly BurningCell[]): void {
    for (const b of snapshot) {
      if (!this.module.getCell(b.cell)) throw new Error(`fire snapshot references unknown cell ${b.cell}`);
      this.burning.set(b.cell, { ...b });
    }
  }
}
