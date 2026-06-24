// P3a tests — per-level nav + stair links. Backward-compat (single level, no links) reproduces FlowField;
// a stair link connects cells across levels; the multi-level flow field traverses links to route a pursuer
// upstairs; with no links present nothing changes.

import { describe, it, expect } from 'vitest';
import { NavGrid } from './navGrid';
import { FlowField } from './flowField';
import { LevelNav, LevelFlowField, LevelFlowFieldCache, resolveLevelMove } from './levelNav';

function grid(w: number, h: number): NavGrid {
  return new NavGrid({ width: w, height: h });
}

describe('LevelNav stair links (P3a)', () => {
  it('addStairLink records BOTH directions (climb up + descend)', () => {
    const nav = new LevelNav([grid(6, 5), grid(6, 5)]);
    const a = nav.grid(0).index(2, 2);
    const b = nav.grid(1).index(2, 2);
    expect(nav.stairLinksFrom(0, a)).toHaveLength(0);
    nav.addStairLink(0, a, 1, b);
    const up = nav.stairLinksFrom(0, a);
    const down = nav.stairLinksFrom(1, b);
    expect(up).toHaveLength(1);
    expect(up[0]).toMatchObject({ fromLevel: 0, fromCell: a, toLevel: 1, toCell: b });
    expect(down).toHaveLength(1);
    expect(down[0]).toMatchObject({ fromLevel: 1, fromCell: b, toLevel: 0, toCell: a });
  });

  it('bumps navRevision on a stair-link edit (so a stale field is dropped)', () => {
    const nav = new LevelNav([grid(4, 4), grid(4, 4)]);
    const r0 = nav.navRevision;
    nav.addStairLink(0, nav.grid(0).index(1, 1), 1, nav.grid(1).index(1, 1));
    expect(nav.navRevision).not.toBe(r0);
  });

  it('validates link cells are in range on their level', () => {
    const nav = new LevelNav([grid(4, 4), grid(4, 4)]);
    expect(() => nav.addStairLink(0, 999, 1, 0)).toThrow(/out of range/);
    expect(() => nav.addStairLink(0, 0, 1, 999)).toThrow(/out of range/);
    expect(() => nav.grid(5)).toThrow(/no level 5/);
  });

  it('requires at least the ground level', () => {
    expect(() => new LevelNav([])).toThrow(/ground level/);
  });
});

describe('LevelFlowField backward-compat (single level, no links)', () => {
  it('reproduces FlowField distances exactly when there are no other levels or links', () => {
    const g = grid(10, 10);
    for (let cy = 0; cy <= 8; cy++) g.block(5, cy); // wall with a gap at cy=9
    const target = g.index(9, 0);
    const ref = new FlowField(g, target, 'ground', g.navRevision);
    const nav = LevelNav.single(g);
    const lvl = new LevelFlowField(nav, 0, target, 'ground', nav.navRevision);
    // every cell's cost-to-target matches the single-grid field byte-for-byte (same neighbour order + costs).
    for (let cell = 0; cell < g.cellCount; cell++) {
      const a = ref.distance[cell]!;
      const b = lvl.distanceAt(0, cell);
      if (Number.isFinite(a)) expect(b).toBeCloseTo(a, 9);
      else expect(Number.isFinite(b)).toBe(false);
    }
  });

  it('never reports a stair climb when there are no links', () => {
    const g = grid(8, 8);
    const nav = LevelNav.single(g);
    const f = new LevelFlowField(nav, 0, g.index(4, 4), 'ground', nav.navRevision);
    for (let cell = 0; cell < g.cellCount; cell++) expect(f.stairFrom(0, cell)).toBeNull();
  });
});

describe('LevelFlowField traverses stair links across levels', () => {
  it('routes a level-0 cell to a target upstairs via the stair link', () => {
    // level 1 is sparse: only a 3x1 strip of cells around the stair is walkable; the rest stays blocked so the
    // ONLY way up is the stair. Block all of level 1 first, then carve the upstairs strip.
    const g0 = grid(8, 4);
    const g1 = grid(8, 4);
    for (let cy = 0; cy < g1.height; cy++) for (let cx = 0; cx < g1.width; cx++) g1.block(cx, cy);
    // carve upstairs landing strip at row 1: cx 4,5,6
    for (const cx of [4, 5, 6]) g1.clear(cx, 1);
    const stair0 = g0.index(4, 1);
    const stair1 = g1.index(4, 1);
    const nav = new LevelNav([g0, g1]);
    nav.addStairLink(0, stair0, 1, stair1);

    const target1 = g1.index(6, 1); // a bedroom cell upstairs
    const field = new LevelFlowField(nav, 1, target1, 'ground', nav.navRevision);

    // a far cell on level 0 must be reachable (the field crossed the stair).
    const far0 = g0.index(0, 1);
    expect(field.isReachable(0, far0)).toBe(true);
    expect(field.isReachable(1, target1)).toBe(true);

    // the stair cell on level 0 should prefer the climb (its cheapest next step is the portal).
    expect(field.stairFrom(0, stair0)).toMatchObject({ toLevel: 1, toCell: stair1 });

    // walk level-0 flow from the far cell — it must converge on the stair cell, then climb.
    let cx = 0;
    let cy = 1;
    let climbed = false;
    for (let s = 0; s < 50; s++) {
      const cell = g0.index(cx, cy);
      if (field.stairFrom(0, cell)) {
        climbed = true;
        break;
      }
      const [dx, dz] = field.directionAt(0, cell);
      const sx = Math.sign(Math.round(dx));
      const sy = Math.sign(Math.round(dz));
      if (sx === 0 && sy === 0) break;
      cx += sx;
      cy += sy;
    }
    expect(climbed).toBe(true);
    expect(g0.index(cx, cy)).toBe(stair0);
  });

  it('a level-1 cell with no path off its level except the stair still reaches a level-0 target', () => {
    const g0 = grid(6, 3);
    const g1 = grid(6, 3);
    for (let cy = 0; cy < g1.height; cy++) for (let cx = 0; cx < g1.width; cx++) g1.block(cx, cy);
    for (const cx of [1, 2, 3]) g1.clear(cx, 1);
    const nav = new LevelNav([g0, g1]);
    nav.addStairLink(0, g0.index(1, 1), 1, g1.index(1, 1));
    const target0 = g0.index(5, 1);
    const f = new LevelFlowField(nav, 0, target0, 'ground', nav.navRevision);
    expect(f.isReachable(1, g1.index(3, 1))).toBe(true);
    // the upstairs cell descends at the stair cell.
    expect(f.stairFrom(1, g1.index(1, 1))).toMatchObject({ toLevel: 0 });
  });

  it('with no stair links a multi-level nav keeps the levels disconnected', () => {
    const g0 = grid(5, 3);
    const g1 = grid(5, 3);
    const nav = new LevelNav([g0, g1]);
    const f = new LevelFlowField(nav, 0, g0.index(2, 1), 'ground', nav.navRevision);
    // level 0 fully reachable; level 1 entirely unreachable (no portal).
    expect(f.isReachable(0, g0.index(0, 0))).toBe(true);
    for (let cell = 0; cell < g1.cellCount; cell++) expect(f.isReachable(1, cell)).toBe(false);
  });
});

describe('resolveLevelMove (shared player/zombie climb decision, P3b)', () => {
  // a 2-level world: level 0 fully open 8x4, level 1 sparse (a 3-cell landing strip at row 1, cx 4..6),
  // a stair link at cx=4,row=1, target a bedroom cell upstairs at (6,1).
  function twoLevel() {
    const g0 = new NavGrid({ width: 8, height: 4 });
    const g1 = new NavGrid({ width: 8, height: 4 });
    for (let cy = 0; cy < g1.height; cy++) for (let cx = 0; cx < g1.width; cx++) g1.block(cx, cy);
    for (const cx of [4, 5, 6]) g1.clear(cx, 1);
    const nav = new LevelNav([g0, g1]);
    nav.addStairLink(0, g0.index(4, 1), 1, g1.index(4, 1));
    const field = new LevelFlowField(nav, 1, g1.index(6, 1), 'ground', nav.navRevision);
    return { g0, g1, nav, field };
  }
  const cs = new NavGrid({ width: 1, height: 1 }).settings.navCellSize; // 2 m

  it('an agent steering toward the target gets a steer move (non-zero flow)', () => {
    const { nav, field } = twoLevel();
    const m = resolveLevelMove(field, nav, 0, 0.5 * cs, 1.5 * cs); // far cell (0,1) on level 0
    expect(m.kind).toBe('steer');
    if (m.kind === 'steer') expect(Math.hypot(m.flowX, m.flowZ)).toBeGreaterThan(0);
  });

  it('an agent standing ON the stair cell is told to CLIMB to the linked level + cell', () => {
    const { g1, nav, field } = twoLevel();
    const m = resolveLevelMove(field, nav, 0, 4.5 * cs, 1.5 * cs); // the level-0 stair cell (4,1)
    expect(m.kind).toBe('climb');
    if (m.kind === 'climb') {
      expect(m.toLevel).toBe(1);
      expect(m.toCell).toBe(g1.index(4, 1));
    }
  });

  it('an agent off-grid / unreachable for the field is told to idle', () => {
    const { nav, field } = twoLevel();
    // a level-1 cell that is blocked (not the landing strip) is unreachable for this field.
    const m = resolveLevelMove(field, nav, 1, 0.5 * cs, 0.5 * cs);
    expect(m.kind).toBe('idle');
  });

  it('a level-0 agent walked down the flow eventually reaches the stair cell and is told to climb', () => {
    const { g0, nav, field } = twoLevel();
    let cx = 0;
    let cy = 1;
    let climbed = false;
    for (let s = 0; s < 50; s++) {
      const m = resolveLevelMove(field, nav, 0, (cx + 0.5) * cs, (cy + 0.5) * cs);
      if (m.kind === 'climb') {
        climbed = true;
        expect(g0.index(cx, cy)).toBe(g0.index(4, 1));
        break;
      }
      expect(m.kind).toBe('steer');
      if (m.kind === 'steer') {
        cx += Math.sign(Math.round(m.flowX));
        cy += Math.sign(Math.round(m.flowZ));
      }
    }
    expect(climbed).toBe(true);
  });
});

describe('LevelFlowFieldCache', () => {
  it('reuses a field for an identical key and recomputes after a nav edit', () => {
    const g0 = grid(8, 8);
    const g1 = grid(8, 8);
    const nav = new LevelNav([g0, g1]);
    const cache = new LevelFlowFieldCache(4);
    const a = cache.get(nav, 0, g0.index(4, 4), 'ground');
    const b = cache.get(nav, 0, g0.index(4, 4), 'ground');
    expect(b).toBe(a);
    g0.block(0, 0); // bumps a level's navRevision → new combined key
    const c = cache.get(nav, 0, g0.index(4, 4), 'ground');
    expect(c).not.toBe(a);
  });
});
