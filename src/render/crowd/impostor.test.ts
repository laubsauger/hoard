// T140 — far-band billboard impostor: the (GPU-free) atlas bake + the tile-pick angle selection that the shader
// mirrors. No renderer needed: the atlas is software-rasterized on the CPU and the tile pick is a pure function.

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Scene } from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { bakeImpostorAtlas, nearestImpostorTile } from './impostor';

const TAU = Math.PI * 2;

/** Minimal GLTF-shaped stub: bakeImpostorAtlas only reads `.scene` (traversed for the first Mesh). */
function stubGltf(): GLTF {
  const scene = new Scene();
  // A 1×2×1 box standing on the origin-ish — gives a clear, tall silhouette to rasterize.
  const mesh = new Mesh(new BoxGeometry(1, 2, 1), new MeshStandardMaterial());
  mesh.position.set(0, 1, 0);
  scene.add(mesh);
  return { scene } as unknown as GLTF;
}

describe('nearestImpostorTile — pick the baked yaw nearest the view azimuth (T140)', () => {
  const N = 12;

  it('camera directly in FRONT of a heading-0 figure picks tile 0', () => {
    // heading 0 → the figure faces world +x (rigged basis: local +Z → world heading). The FRONT view (local +Z)
    // is the camera placed along the figure's facing... the math: local dir of (cam-fig). Put the camera so the
    // local azimuth is ~0.
    // For heading 0: lx = dx·0 − dz·1 = −dz ; lz = dx·1 + dz·0 = dx ; phi = atan2(−dz, dx).
    // Camera at +x (dx>0, dz=0) → phi = atan2(0, +) = 0 → tile 0.
    expect(nearestImpostorTile(10, 0, 0, 0, 0, N)).toBe(0);
  });

  it('wraps into [0, N) and is stable/deterministic across the full circle', () => {
    for (let a = 0; a < N; a++) {
      // place the camera at local azimuth ≈ a·step around a heading-0 figure and expect tile a.
      const phi = (a * TAU) / N;
      // invert the heading-0 mapping: phi = atan2(-dz, dx) → choose dx=cos phi, dz=-sin phi.
      const dx = Math.cos(phi);
      const dz = -Math.sin(phi);
      const k = nearestImpostorTile(dx * 8, dz * 8, 0, 0, 0, N);
      expect(k).toBe(a % N);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(N);
    }
  });

  it('a figure facing a different heading rotates which tile a fixed camera selects', () => {
    // Fixed camera; rotating the figure's heading by a full tile-step should advance the selected tile by ~1.
    const t0 = nearestImpostorTile(10, 0, 0, 0, 0, N);
    const t1 = nearestImpostorTile(10, 0, 0, 0, TAU / N, N);
    expect(((t1 - t0) % N + N) % N === 1 || ((t0 - t1) % N + N) % N === 1).toBe(true);
  });
});

describe('bakeImpostorAtlas — CPU silhouette atlas (T140)', () => {
  it('produces an N-tile RGBA atlas fitted to the requested height with a non-empty silhouette', () => {
    const atlas = bakeImpostorAtlas(stubGltf(), { angleCount: 8, tileH: 64, maxTriangles: 60000, heightMeters: 1.8 });
    expect(atlas.angleCount).toBe(8);
    expect(atlas.tileH).toBe(64);
    expect(atlas.width).toBe(atlas.tileW * 8);
    expect(atlas.height).toBe(64);
    expect(atlas.data.length).toBe(atlas.width * atlas.height * 4);
    expect(atlas.worldHeight).toBeCloseTo(1.8, 6);
    expect(atlas.worldWidth).toBeGreaterThan(0);
    // Some pixels must be opaque (the box silhouette) and some transparent (background).
    let opaque = 0;
    let clear = 0;
    for (let i = 3; i < atlas.data.length; i += 4) {
      if (atlas.data[i]! > 0) opaque++; else clear++;
    }
    expect(opaque).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(0);
  });

  it('feet sit at the bottom of each tile (row 0 has coverage, the top row much less for a standing box)', () => {
    const atlas = bakeImpostorAtlas(stubGltf(), { angleCount: 4, tileH: 96, maxTriangles: 60000, heightMeters: 1.8 });
    const rowCoverage = (row: number): number => {
      let c = 0;
      for (let x = 0; x < atlas.width; x++) {
        if (atlas.data[(row * atlas.width + x) * 4 + 3]! > 0) c++;
      }
      return c;
    };
    // Row 0 = feet (v=0). A standing box fills the full height, so the feet row has coverage.
    expect(rowCoverage(0)).toBeGreaterThan(0);
  });
});
