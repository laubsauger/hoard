// T12 / V6 / V19 — broad-phase uniform-grid spatial hash for dynamic agents.
// Default proxy = circle (radius) + vertical bounds (yMin..yMax) — promotable to capsule/anatomical
// on demand by a higher tier (out of scope here). A neighbour query inspects ONLY the query cell plus
// a bounded ring of cells (config: neighborRings), never the whole grid — that boundedness is what
// keeps crowd collision cheap as density rises (V19).

import { resolveDomain } from '@/config/registry';
import { collisionConfig } from '@/config/domains/collision';
import type { QualityTier, ResolvedDomain } from '@/config/types';
import { layersOverlap } from './layers';

export type CollisionSettings = ResolvedDomain<typeof collisionConfig>;

const REFERENCE_TIER: QualityTier = 'desktop-high';

export interface Agent {
  readonly id: number;
  x: number;
  z: number;
  radius: number;
  yMin: number;
  yMax: number;
  /** Bitmask of CollisionLayer values this agent participates in. */
  layers: number;
}

export interface SpatialHashOptions {
  readonly tier?: QualityTier;
  /** Override broad-phase cell size (meters). Defaults to collision config. */
  readonly cellSize?: number;
}

export class SpatialHash {
  readonly settings: CollisionSettings;
  readonly cellSize: number;
  private readonly agents = new Map<number, Agent>();
  /** cellKey -> set of agent ids occupying that cell. */
  private readonly cells = new Map<string, Set<number>>();
  /** agent id -> the cellKey it currently lives in (for O(1) move/remove). */
  private readonly placement = new Map<number, string>();
  private _lastCandidateCount = 0;

  constructor(opts: SpatialHashOptions = {}) {
    this.settings = resolveDomain(collisionConfig, opts.tier ?? REFERENCE_TIER);
    this.cellSize = opts.cellSize ?? this.settings.broadPhaseCellSize;
    if (this.cellSize <= 0) throw new Error(`cellSize must be > 0, got ${this.cellSize}`);
  }

  get size(): number {
    return this.agents.size;
  }

  /** Candidate count gathered by the most recent query (diagnostics — V/§I debug views). */
  get lastCandidateCount(): number {
    return this._lastCandidateCount;
  }

  private cellCoord(x: number, z: number): { cx: number; cy: number } {
    return { cx: Math.floor(x / this.cellSize), cy: Math.floor(z / this.cellSize) };
  }

  private static key(cx: number, cy: number): string {
    return `${cx}|${cy}`;
  }

  /** Insert a new agent. Throws on duplicate id (no silent overwrite). */
  insert(agent: Agent): void {
    if (this.agents.has(agent.id)) throw new Error(`agent ${agent.id} already inserted`);
    if (agent.radius <= 0) throw new Error(`agent ${agent.id} radius must be > 0`);
    if (agent.yMax < agent.yMin) throw new Error(`agent ${agent.id} yMax < yMin`);
    this.agents.set(agent.id, agent);
    const { cx, cy } = this.cellCoord(agent.x, agent.z);
    this.addToCell(agent.id, SpatialHash.key(cx, cy));
  }

  has(id: number): boolean {
    return this.agents.has(id);
  }

  get(id: number): Agent {
    const a = this.agents.get(id);
    if (!a) throw new Error(`unknown agent ${id}`);
    return a;
  }

  /** Move an agent; re-buckets only if it crossed a cell boundary. */
  update(id: number, x: number, z: number): void {
    const agent = this.get(id);
    agent.x = x;
    agent.z = z;
    const { cx, cy } = this.cellCoord(x, z);
    const newKey = SpatialHash.key(cx, cy);
    const oldKey = this.placement.get(id);
    if (oldKey !== newKey) {
      if (oldKey) this.removeFromCell(id, oldKey);
      this.addToCell(id, newKey);
    }
  }

  remove(id: number): void {
    const key = this.placement.get(id);
    if (key) this.removeFromCell(id, key);
    this.agents.delete(id);
  }

  /**
   * Neighbour query: agent ids within `radius` of (x,z) on `layerMask`, inspecting only the query
   * cell + `neighborRings` rings (bounded). Optionally exclude one id (the querying agent).
   * `requireVertical` also tests vertical-bounds overlap against [yMin,yMax].
   */
  query(
    x: number,
    z: number,
    radius: number,
    layerMask: number,
    opts: { exclude?: number; yMin?: number; yMax?: number } = {},
  ): number[] {
    if (radius < 0) throw new Error(`query radius must be non-negative, got ${radius}`);
    const { cx, cy } = this.cellCoord(x, z);
    const rings = this.settings.neighborRings;
    const result: number[] = [];
    let candidates = 0;
    for (let dy = -rings; dy <= rings; dy++) {
      for (let dx = -rings; dx <= rings; dx++) {
        const bucket = this.cells.get(SpatialHash.key(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const id of bucket) {
          if (id === opts.exclude) continue;
          candidates += 1;
          const a = this.agents.get(id)!;
          if (!layersOverlap(a.layers, layerMask)) continue;
          const dxw = a.x - x;
          const dzw = a.z - z;
          const reach = radius + a.radius;
          if (dxw * dxw + dzw * dzw > reach * reach) continue;
          if (opts.yMin !== undefined && opts.yMax !== undefined) {
            if (a.yMax < opts.yMin || a.yMin > opts.yMax) continue;
          }
          result.push(id);
        }
      }
    }
    this._lastCandidateCount = candidates;
    return result;
  }

  /** Number of occupied cells (diagnostics). */
  get occupiedCellCount(): number {
    return this.cells.size;
  }

  private addToCell(id: number, key: string): void {
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = new Set();
      this.cells.set(key, bucket);
    }
    bucket.add(id);
    this.placement.set(id, key);
  }

  private removeFromCell(id: number, key: string): void {
    const bucket = this.cells.get(key);
    if (bucket) {
      bucket.delete(id);
      if (bucket.size === 0) this.cells.delete(key);
    }
    this.placement.delete(id);
  }
}
