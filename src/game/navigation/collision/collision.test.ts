// T12 tests — V6 (layer separation), V19 (bounded neighbour query correctness).

import { describe, it, expect } from 'vitest';
import { SpatialHash } from './spatialHash';
import { CollisionLayer, layerMask, layersOverlap } from './layers';

function agent(id: number, x: number, z: number, layers: number, radius = 0.35) {
  return { id, x, z, radius, yMin: 0, yMax: 1.8, layers };
}

describe('collision layers (V6)', () => {
  it('composes masks and detects overlap', () => {
    const m = layerMask(CollisionLayer.Movement, CollisionLayer.Sight);
    expect(layersOverlap(m, CollisionLayer.Movement)).toBe(true);
    expect(layersOverlap(m, CollisionLayer.Projectile)).toBe(false);
  });
});

describe('SpatialHash broad-phase (T12)', () => {
  it('finds near neighbours and excludes far ones (bounded query)', () => {
    const sh = new SpatialHash({ cellSize: 2 });
    sh.insert(agent(1, 0, 0, CollisionLayer.Movement));
    sh.insert(agent(2, 0.5, 0, CollisionLayer.Movement)); // near
    sh.insert(agent(3, 50, 50, CollisionLayer.Movement)); // far, different cell region
    const near = sh.query(0, 0, 1, CollisionLayer.Movement, { exclude: 1 });
    expect(near).toContain(2);
    expect(near).not.toContain(3);
  });

  it('only inspects bounded cells, not the whole grid (candidate count stays local)', () => {
    const sh = new SpatialHash({ cellSize: 1 }); // neighborRings default 1 -> 3x3 cells
    // scatter many far agents that must not be inspected
    for (let i = 0; i < 100; i++) sh.insert(agent(100 + i, 1000 + i, 1000 + i, CollisionLayer.Movement));
    sh.insert(agent(1, 0, 0, CollisionLayer.Movement));
    sh.insert(agent(2, 0.4, 0.4, CollisionLayer.Movement));
    sh.query(0, 0, 0.5, CollisionLayer.Movement);
    // candidates inspected = only those in the 3x3 cell window around origin (here just 1 & 2)
    expect(sh.lastCandidateCount).toBeLessThanOrEqual(2);
    expect(sh.size).toBe(102);
  });

  it('separates layers — a projectile-only agent never matches a movement query (V6)', () => {
    const sh = new SpatialHash({ cellSize: 2 });
    sh.insert(agent(1, 0, 0, CollisionLayer.Movement));
    sh.insert(agent(2, 0.3, 0, CollisionLayer.Projectile)); // overlapping in space, different layer
    const movement = sh.query(0, 0, 1, CollisionLayer.Movement, { exclude: 1 });
    expect(movement).not.toContain(2);
    const projectile = sh.query(0, 0, 1, CollisionLayer.Projectile);
    expect(projectile).toContain(2);
  });

  it('respects vertical bounds when requested', () => {
    const sh = new SpatialHash({ cellSize: 2 });
    sh.insert({ id: 1, x: 0, z: 0, radius: 0.5, yMin: 0, yMax: 1, layers: CollisionLayer.Movement });
    sh.insert({ id: 2, x: 0.3, z: 0, radius: 0.5, yMin: 3, yMax: 4, layers: CollisionLayer.Movement }); // above
    const sameLevel = sh.query(0, 0, 1, CollisionLayer.Movement, { exclude: 1, yMin: 0, yMax: 1 });
    expect(sameLevel).not.toContain(2);
    const overlapping = sh.query(0, 0, 1, CollisionLayer.Movement, { exclude: 1, yMin: 0, yMax: 5 });
    expect(overlapping).toContain(2);
  });

  it('re-buckets on movement and removes cleanly', () => {
    const sh = new SpatialHash({ cellSize: 2 });
    sh.insert(agent(1, 0, 0, CollisionLayer.Movement));
    sh.insert(agent(2, 0, 0, CollisionLayer.Movement));
    sh.update(1, 100, 100); // move far away
    expect(sh.query(0, 0, 1, CollisionLayer.Movement, { exclude: 2 })).not.toContain(1);
    expect(sh.query(100, 100, 1, CollisionLayer.Movement)).toContain(1);
    sh.remove(1);
    expect(sh.has(1)).toBe(false);
  });

  it('rejects duplicate inserts and invalid proxies (no silent fallback)', () => {
    const sh = new SpatialHash({ cellSize: 2 });
    sh.insert(agent(1, 0, 0, CollisionLayer.Movement));
    expect(() => sh.insert(agent(1, 0, 0, CollisionLayer.Movement))).toThrow(/already/);
    expect(() => sh.insert({ id: 9, x: 0, z: 0, radius: 0, yMin: 0, yMax: 1, layers: 1 })).toThrow(/radius/);
  });
});
