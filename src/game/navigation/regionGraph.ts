// T11 — region + portal graph.
// Coarse traversal topology above the cost grid: regions (rooms/streets) are nodes, portals
// (doorways/breaches/openings) are edges. Long-range routing picks a portal sequence; the shared
// flow field then handles local movement within the active region (V15). A breach (T13) adds a
// portal here without touching the fine grid globally.

import type { NavTileId } from '@/game/core/contracts';

export interface Portal {
  readonly id: number;
  readonly from: number;
  readonly to: number;
  /** Representative nav cell the portal passes through (for flow-field targeting). */
  readonly cell: number;
  /** Traversal cost across the portal. */
  readonly cost: number;
  /** Open portals are traversable; a locked door / sealed breach is closed. */
  open: boolean;
}

export class RegionGraph {
  private readonly regions = new Set<number>();
  private readonly portals = new Map<number, Portal>();
  private readonly adjacency = new Map<number, Set<number>>(); // region -> portal ids
  private nextPortalId = 0;

  addRegion(region: number): void {
    this.regions.add(region);
    if (!this.adjacency.has(region)) this.adjacency.set(region, new Set());
  }

  hasRegion(region: number): boolean {
    return this.regions.has(region);
  }

  get regionCount(): number {
    return this.regions.size;
  }

  get portalCount(): number {
    return this.portals.size;
  }

  /** Connect two regions with a portal. Both regions are auto-registered. Returns the portal id. */
  addPortal(from: number, to: number, cell: number, cost: number, open = true): number {
    if (from === to) throw new Error(`portal cannot connect a region to itself (${from})`);
    if (cost < 0 || Number.isNaN(cost)) throw new Error(`portal cost must be non-negative, got ${cost}`);
    this.addRegion(from);
    this.addRegion(to);
    const id = this.nextPortalId++;
    const portal: Portal = { id, from, to, cell, cost, open };
    this.portals.set(id, portal);
    this.adjacency.get(from)!.add(id);
    this.adjacency.get(to)!.add(id);
    return id;
  }

  getPortal(id: number): Portal {
    const p = this.portals.get(id);
    if (!p) throw new Error(`unknown portal ${id}`);
    return p;
  }

  setPortalOpen(id: number, open: boolean): void {
    this.getPortal(id).open = open;
  }

  /** Open portal ids incident to a region. */
  portalsOf(region: number): Portal[] {
    const ids = this.adjacency.get(region);
    if (!ids) return [];
    return [...ids].map((id) => this.portals.get(id)!);
  }

  /** Reachable neighbour regions through open portals. */
  neighbors(region: number): number[] {
    return this.portalsOf(region)
      .filter((p) => p.open)
      .map((p) => (p.from === region ? p.to : p.from));
  }

  /**
   * Lowest-cost region path from→to over OPEN portals (Dijkstra on the coarse graph).
   * Returns the region sequence (inclusive), or null if unreachable.
   */
  route(from: number, to: number): number[] | null {
    if (!this.regions.has(from) || !this.regions.has(to)) return null;
    if (from === to) return [from];
    const dist = new Map<number, number>([[from, 0]]);
    const prev = new Map<number, number>();
    const visited = new Set<number>();
    const queue = new Set<number>([from]);
    while (queue.size > 0) {
      let cur = -1;
      let best = Infinity;
      for (const r of queue) {
        const d = dist.get(r) ?? Infinity;
        if (d < best) { best = d; cur = r; }
      }
      queue.delete(cur);
      if (cur === to) break;
      visited.add(cur);
      for (const p of this.portalsOf(cur)) {
        if (!p.open) continue;
        const nb = p.from === cur ? p.to : p.from;
        if (visited.has(nb)) continue;
        const nd = best + p.cost;
        if (nd < (dist.get(nb) ?? Infinity)) {
          dist.set(nb, nd);
          prev.set(nb, cur);
          queue.add(nb);
        }
      }
    }
    if (!dist.has(to)) return null;
    const path: number[] = [to];
    let node = to;
    while (node !== from) {
      const p = prev.get(node);
      if (p === undefined) return null;
      path.push(p);
      node = p;
    }
    return path.reverse();
  }
}

/** Marker re-export so callers can address tiles by branded id when integrating with chunks. */
export type { NavTileId };
