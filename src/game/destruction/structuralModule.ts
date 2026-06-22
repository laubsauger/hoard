// T13 / V5 / V18 / V30 — sparse StructuralModule.
// The authored visible mesh is separate (V6); this is the hidden destructible grid. Cells are stored
// SPARSELY (a Map keyed by packed local index) — only walls/floors/doors/supports occupy cells.
// applyDamage drives a cell past its fracture family's breach threshold → an IRREGULAR breach hole
// (V30, hides the cubic cell shape), a LOCAL nav + collision update + WorldEvents (V5 — never a full
// region remesh/nav rebuild), and a compact persistent modification delta (V18 — state, not a log of
// thousands of rigid bodies). A breach that removes a support collapses dependents that lose their
// path to an anchor.

import { resolveDomain } from '@/config/registry';
import { structuresConfig } from '@/config/domains/structures';
import { destructionConfig } from '@/config/domains/destruction';
import type { QualityTier, ResolvedDomain } from '@/config/types';
import type { EventId, ModuleId, WorldEvent } from '@/game/core/contracts';

export type Material = 'wood' | 'brick' | 'concrete' | 'glass' | 'metal';

export interface StructuralCell {
  readonly index: number;
  readonly material: Material;
  readonly maxStrength: number;
  strength: number;
  /** Fracture family id — cells in a family breach together with a shared threshold. */
  readonly family: number;
  /** Door/window/service route — an authored opening (already passable). */
  readonly opening: boolean;
  breached: boolean;
}

/** Compact persistent modification record per cell (V9/V18 — deltas separate from base packages). */
export interface CellDelta {
  readonly cell: number;
  strength: number;
  breached: boolean;
}

export interface FractureFamily {
  readonly id: number;
  /** Fraction of max strength that must be removed before a cell in this family breaches. */
  readonly breachThresholdRatio: number;
  readonly cells: Set<number>;
}

/** Side-effect surface the module drives on a breach. All optional so the module is usable standalone. */
export interface StructuralHooks {
  /** Mint an EventId (deterministic via IdFactory — V26). */
  nextEventId(): EventId;
  /** Receive a persistent WorldEvent (breachCreated / structureModified). */
  emit(event: WorldEvent): void;
  /**
   * Apply the LOCAL nav + collision opening for a breached cell (V5). The implementer maps the
   * module-local cell to its nav tiles / collision proxy and marks ONLY those dirty.
   */
  openCell?(module: ModuleId, cell: number): void;
}

export interface StructuralModuleOptions {
  readonly id: ModuleId;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly tier?: QualityTier;
  /** Deterministic seed for irregular-breach jitter (V26 — reproducible). */
  readonly seed?: number;
}

const REFERENCE_TIER: QualityTier = 'desktop-high';

type StructuresSettings = ResolvedDomain<typeof structuresConfig>;
type DestructionSettings = ResolvedDomain<typeof destructionConfig>;

/** Deterministic PRNG (mulberry32) so irregular breaches replay identically (V26). */
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

export interface BreachResult {
  /** Cells whose geometry was removed (the irregular hole footprint — primary + spread). */
  readonly breached: number[];
  /** Cells that collapsed afterwards from losing support. */
  readonly collapsed: number[];
}

export class StructuralModule {
  readonly id: ModuleId;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly structures: StructuresSettings;
  readonly destruction: DestructionSettings;

  private readonly cells = new Map<number, StructuralCell>();
  private readonly families = new Map<number, FractureFamily>();
  private readonly supporters = new Map<number, Set<number>>(); // cell -> cells that support it
  private readonly anchors = new Set<number>();
  private readonly openings = new Set<number>();
  /** Compact persistent modification delta (V18). Keyed by cell — overwritten, never appended-forever. */
  private readonly delta = new Map<number, CellDelta>();
  private readonly rand: () => number;

  constructor(opts: StructuralModuleOptions) {
    for (const [k, v] of [['sizeX', opts.sizeX], ['sizeY', opts.sizeY], ['sizeZ', opts.sizeZ]] as const) {
      if (!Number.isInteger(v) || v <= 0) throw new Error(`StructuralModule ${k} must be a positive integer, got ${v}`);
    }
    this.id = opts.id;
    this.sizeX = opts.sizeX;
    this.sizeY = opts.sizeY;
    this.sizeZ = opts.sizeZ;
    this.structures = resolveDomain(structuresConfig, opts.tier ?? REFERENCE_TIER);
    this.destruction = resolveDomain(destructionConfig, opts.tier ?? REFERENCE_TIER);
    this.rand = mulberry32((opts.seed ?? 1) ^ (opts.id as number));
  }

  // ---- local-index packing ----
  packCell(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= this.sizeX || y >= this.sizeY || z >= this.sizeZ) {
      throw new Error(`cell (${x},${y},${z}) out of module bounds ${this.sizeX}x${this.sizeY}x${this.sizeZ}`);
    }
    return x + y * this.sizeX + z * this.sizeX * this.sizeY;
  }

  unpackCell(index: number): { x: number; y: number; z: number } {
    const x = index % this.sizeX;
    const y = Math.floor(index / this.sizeX) % this.sizeY;
    const z = Math.floor(index / (this.sizeX * this.sizeY));
    return { x, y, z };
  }

  get cellCount(): number {
    return this.cells.size;
  }

  get familyCount(): number {
    return this.families.size;
  }

  getCell(index: number): StructuralCell | undefined {
    return this.cells.get(index);
  }

  isBreached(index: number): boolean {
    const c = this.cells.get(index);
    return c ? c.breached : false;
  }

  isPassable(index: number): boolean {
    const c = this.cells.get(index);
    // unoccupied space, authored openings, and breached cells are passable
    return !c || c.opening || c.breached;
  }

  // ---- authoring ----
  addCell(opts: {
    x: number;
    y: number;
    z: number;
    material: Material;
    family: number;
    strength?: number;
    opening?: boolean;
    anchor?: boolean;
  }): number {
    const index = this.packCell(opts.x, opts.y, opts.z);
    if (this.cells.has(index)) throw new Error(`cell ${index} already occupied`);
    const maxStrength = opts.strength ?? this.structures.defaultCellStrength;
    const cell: StructuralCell = {
      index,
      material: opts.material,
      maxStrength,
      strength: maxStrength,
      family: opts.family,
      opening: opts.opening ?? false,
      breached: false,
    };
    this.cells.set(index, cell);
    if (opts.opening) this.openings.add(index);
    if (opts.anchor) this.anchors.add(index);
    let fam = this.families.get(opts.family);
    if (!fam) {
      fam = { id: opts.family, breachThresholdRatio: this.destruction.breachThresholdRatio, cells: new Set() };
      this.families.set(opts.family, fam);
    }
    fam.cells.add(index);
    return index;
  }

  setFamilyBreachThreshold(family: number, ratio: number): void {
    if (ratio <= 0 || ratio > 1) throw new Error(`breach threshold ratio must be in (0,1], got ${ratio}`);
    const fam = this.families.get(family);
    if (!fam) throw new Error(`unknown fracture family ${family}`);
    this.families.set(family, { ...fam, breachThresholdRatio: ratio });
  }

  /** Declare that `cell` is held up by `by` (support-graph edge). */
  addSupport(cell: number, by: number): void {
    if (!this.cells.has(cell)) throw new Error(`unknown cell ${cell}`);
    if (!this.cells.has(by)) throw new Error(`unknown supporter ${by}`);
    let s = this.supporters.get(cell);
    if (!s) { s = new Set(); this.supporters.set(cell, s); }
    s.add(by);
  }

  isOpening(index: number): boolean {
    return this.openings.has(index);
  }

  isAnchor(index: number): boolean {
    return this.anchors.has(index);
  }

  // ---- damage + breach ----
  /**
   * Apply `amount` damage to a cell. If the damage crosses the family breach threshold, the cell
   * breaches: an irregular hole forms (V30), LOCAL nav/collision open (V5), WorldEvents emit, and the
   * compact delta records the new state (V18). Returns the breach result, or null if no breach.
   */
  applyDamage(index: number, amount: number, hooks: StructuralHooks): BreachResult | null {
    if (amount < 0 || Number.isNaN(amount)) throw new Error(`damage amount must be non-negative, got ${amount}`);
    const cell = this.cells.get(index);
    if (!cell) throw new Error(`cannot damage empty cell ${index}`);
    if (cell.breached) return null;

    cell.strength = Math.max(0, cell.strength - amount);
    this.recordDelta(cell);
    // Every damage application is a persistent structural modification (feeds save + AI).
    hooks.emit({ kind: 'structureModified', id: hooks.nextEventId(), module: this.id, cell: index });

    const fam = this.families.get(cell.family)!;
    const removedRatio = (cell.maxStrength - cell.strength) / cell.maxStrength;
    if (removedRatio < fam.breachThresholdRatio) return null;

    // --- breach ---
    const footprint = this.computeIrregularFootprint(index, fam);
    for (const fc of footprint) this.breachCell(fc, hooks);
    hooks.emit({ kind: 'breachCreated', id: hooks.nextEventId(), module: this.id, cell: index });

    // --- support cascade: cells that lost their path to an anchor collapse too ---
    const collapsed = this.collapseUnsupported(hooks);

    return { breached: footprint, collapsed };
  }

  /**
   * Add structural strength to a cell (board/reinforce/brace/weld — T25 functional-mod). Strength may
   * rise ABOVE the base maxStrength: that extra buffer means more damage is needed to cross the family
   * breach threshold (reinforcement = more effective HP). The new strength persists in the compact
   * delta (V18). Returns the resulting strength.
   */
  reinforce(index: number, addedStrength: number): number {
    if (addedStrength < 0 || Number.isNaN(addedStrength)) {
      throw new Error(`reinforce amount must be non-negative, got ${addedStrength}`);
    }
    const cell = this.cells.get(index);
    if (!cell) throw new Error(`cannot reinforce empty cell ${index}`);
    if (cell.breached) throw new Error(`cannot reinforce a breached cell ${index}`);
    cell.strength += addedStrength;
    this.recordDelta(cell);
    return cell.strength;
  }

  /** Current compact modification delta (V18) — what a save would persist on top of the base package. */
  modificationDelta(): CellDelta[] {
    return [...this.delta.values()].map((d) => ({ ...d }));
  }

  /** Re-apply a previously-saved delta (V9 — base package + delta = current state). */
  applyDeltaSnapshot(deltas: readonly CellDelta[]): void {
    for (const d of deltas) {
      const cell = this.cells.get(d.cell);
      if (!cell) throw new Error(`delta references unknown cell ${d.cell}`);
      cell.strength = d.strength;
      cell.breached = d.breached;
      this.delta.set(d.cell, { cell: d.cell, strength: d.strength, breached: d.breached });
    }
  }

  // ---- internals ----
  private breachCell(index: number, hooks: StructuralHooks): void {
    const cell = this.cells.get(index);
    if (!cell || cell.breached) return;
    cell.breached = true;
    cell.strength = 0;
    this.recordDelta(cell);
    hooks.openCell?.(this.id, index); // LOCAL nav + collision update (V5)
  }

  /**
   * Irregular footprint (V30): the primary cell plus a probabilistic subset of same-family neighbours
   * within breachSpreadRadius. The probabilistic inclusion is what hides the cubic cell shape.
   */
  private computeIrregularFootprint(primary: number, fam: FractureFamily): number[] {
    const out = new Set<number>([primary]);
    const radius = this.structures.breachSpreadRadius;
    if (radius <= 0) return [...out];
    const { x, y, z } = this.unpackCell(primary);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (nx < 0 || ny < 0 || nz < 0 || nx >= this.sizeX || ny >= this.sizeY || nz >= this.sizeZ) continue;
          const ncell = nx + ny * this.sizeX + nz * this.sizeX * this.sizeY;
          if (!fam.cells.has(ncell)) continue; // spread only within the fracture family
          const c = this.cells.get(ncell);
          if (!c || c.breached) continue;
          if (this.rand() < this.destruction.breachIrregularity) out.add(ncell);
        }
      }
    }
    return [...out];
  }

  /** Cells (non-anchor) with no surviving support path to an anchor collapse. Returns their indices. */
  private collapseUnsupported(hooks: StructuralHooks): number[] {
    // supported set seeded with non-breached anchors, grown over non-breached supporters to fixpoint.
    const supported = new Set<number>();
    for (const a of this.anchors) {
      const c = this.cells.get(a);
      if (c && !c.breached) supported.add(a);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const [index, cell] of this.cells) {
        if (cell.breached || supported.has(index)) continue;
        const sup = this.supporters.get(index);
        if (!sup) continue;
        for (const s of sup) {
          if (supported.has(s)) { supported.add(index); changed = true; break; }
        }
      }
    }
    const collapsed: number[] = [];
    for (const [index, cell] of this.cells) {
      if (cell.breached) continue;
      if (this.anchors.has(index)) continue;
      // only cells that declared supporters participate in collapse; free-standing cells stay
      if (!this.supporters.has(index)) continue;
      if (!supported.has(index)) {
        this.breachCell(index, hooks);
        hooks.emit({ kind: 'breachCreated', id: hooks.nextEventId(), module: this.id, cell: index });
        collapsed.push(index);
      }
    }
    return collapsed;
  }

  private recordDelta(cell: StructuralCell): void {
    this.delta.set(cell.index, { cell: cell.index, strength: cell.strength, breached: cell.breached });
  }
}
