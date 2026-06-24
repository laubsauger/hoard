// T115/V81 — WINDOWS GLOW, never the box. The active-interactable silhouette outline (T113) must resolve EVERY
// window interactable to its real tagged render meshes (frame/pane/void/boards) so the glow hugs the actual pane
// — upright, correctly oriented (from the placement `ns`), at the true sill — with ZERO box fallbacks. This is
// the protective regression test for the "too high / 90°-rotated" window bug (which was the box-fallback path).
// CPU-only (no GPU) — builds the real district scene + runtime + BlockScene and checks mesh resolution.
import { describe, it, expect } from 'vitest';
import { Box3, Vector3 } from 'three';
import { GameRuntime } from '../../game/runtime';
import { buildCityDistrict } from '../../game/scene';
import { InMemoryPersistenceAdapter } from '../../game/persistence';
import { ResourceRegistry } from '../engine';
import { BlockScene } from '../scene/blockScene';
import { collectInteractableMeshes } from './highlightView';

const TIER = 'desktop-high' as const;

describe('window highlight resolves to GLOW meshes, never the box (T115/V81)', () => {
  const d = buildCityDistrict(TIER);
  const runtime = new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: d.block, sectors: d.sectors });
  const registry = new ResourceRegistry();
  const scene = new BlockScene({ runtime, tier: TIER, registry });
  const grid = runtime.scene.navGrid;
  const cs = grid.settings.navCellSize;
  const windows = runtime.interactables().filter((t) => t.kind === 'window');

  it('the district has windows to highlight', () => {
    expect(windows.length).toBeGreaterThan(0);
  });

  it('EVERY window resolves to ≥1 tagged render mesh (glow, never the box fallback)', () => {
    // navCell resolution mirrors the runtime: grid.index(floor(x/cs), floor(z/cs)).
    let boxFallbacks = 0;
    for (const w of windows) {
      const navCell = grid.index(Math.floor(w.x / cs), Math.floor(w.z / cs));
      if (collectInteractableMeshes(scene.scene, navCell).length === 0) boxFallbacks++;
    }
    expect(boxFallbacks).toBe(0);
  });

  it('the glow hugs the real pane: upright at the true sill + correctly oriented, for ALL windows', () => {
    const center = new Vector3();
    const size = new Vector3();
    const box = new Box3();
    const tmp = new Box3();
    const wallH = 3; // default storey height (the district is single-storey, sill centre ≈0.5·wallH)
    for (const w of windows) {
      const navCell = grid.index(Math.floor(w.x / cs), Math.floor(w.z / cs));
      const meshes = collectInteractableMeshes(scene.scene, navCell);
      box.makeEmpty();
      for (const m of meshes) {
        m.updateWorldMatrix(true, false);
        tmp.setFromObject(m);
        box.union(tmp);
      }
      box.getCenter(center);
      box.getSize(size);
      // Upright at the true sill: the glow centre sits at ~half the wall height (the real window centre), NOT
      // floating high (the old box was at 0.65·wallH).
      expect(center.y).toBeCloseTo(wallH * 0.5, 1);
      // Correctly oriented: the wide axis is the wall RUN (the glow hugs the pane in-plane), the thin axis is the
      // wall NORMAL — so one planar extent is clearly wider than the other (never a fat square or a rotated slab).
      const wide = Math.max(size.x, size.z);
      const thin = Math.min(size.x, size.z);
      expect(wide).toBeGreaterThan(thin * 2);
    }
  });
});
