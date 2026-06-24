// P1c — furniture + per-room floor builders. CPU-only (no GPU): we assert the kind/colour tables cover every
// furniture kind, that buildFurniture emits tracked instanced meshes into the scene, and that buildGround splits
// a templated house's floor into one tinted quad PER ROOM (each room reads as its own space in the cutaway).

import { describe, expect, it } from 'vitest';
import { InstancedMesh, Mesh, Scene } from 'three';
import { ResourceRegistry } from '../../engine/resources';
import { SceneResources } from './sceneResources';
import { buildCityDistrict, FURNITURE_SOLIDITY } from '../../../game/scene';
import type { FurnitureKind } from '../../../game/scene';
import { buildFurniture, FURNITURE_FACING_ROT, FURNITURE_KIND_PARTS } from './furnitureBuilder';
import { buildGround } from './groundBuilder';
import { collectInteractableMeshes } from '../../effects/highlightView';
import type { BuildContext } from './buildContext';

function ctxFor(): { ctx: BuildContext; registry: ResourceRegistry; root: Scene } {
  const { block } = buildCityDistrict();
  const root = new Scene();
  const registry = new ResourceRegistry();
  const res = new SceneResources(registry);
  return { ctx: { root, res, town: block, navCellSize: block.navGrid.settings.navCellSize }, registry, root };
}

describe('furnitureBuilder', () => {
  it('has a geometry program for EVERY furniture kind and a rotation for every facing', () => {
    for (const kind of Object.keys(FURNITURE_SOLIDITY) as FurnitureKind[]) {
      expect(FURNITURE_KIND_PARTS[kind].length).toBeGreaterThan(0);
    }
    expect(Object.keys(FURNITURE_FACING_ROT).sort()).toEqual(['e', 'n', 's', 'w']);
  });

  it('emits tracked instanced furniture meshes into the scene (one batch per colour, cheap)', () => {
    const { ctx, registry, root } = ctxFor();
    const before = registry.size;
    buildFurniture(ctx, { floorThicknessMeters: 0.1 });
    const instanced = root.children.filter((c): c is InstancedMesh => c instanceof InstancedMesh);
    expect(instanced.length).toBeGreaterThan(0);
    // batched by colour palette — far fewer draw calls than furniture pieces.
    expect(instanced.length).toBeLessThan(40);
    for (const m of instanced) {
      expect(m.count).toBeGreaterThan(0);
      expect(m.castShadow).toBe(true);
      expect(m.receiveShadow).toBe(true);
    }
    expect(registry.size).toBeGreaterThan(before); // tracked for disposal (V24)
  });

  it('tags each CONTAINER piece mesh with its anchor nav cell so the silhouette glow hugs THAT piece (V79)', () => {
    const { ctx, root } = ctxFor();
    buildFurniture(ctx, { floorThicknessMeters: 0.1 });
    const grid = ctx.town.navGrid;
    const pieces = ctx.town.placedFurniture ?? [];
    const containers = pieces.filter((p) => p.container !== null);
    expect(containers.length).toBeGreaterThan(0);
    // every container's boxes are individually tagged + resolvable by its nav cell (== grid.index(cx,cy), the
    // SAME cell the runtime resolves the highlight target by) → the glow outlines this piece's real shape.
    for (const piece of containers) {
      const meshes = collectInteractableMeshes(root, grid.index(piece.cx, piece.cy));
      expect(meshes.length).toBe(FURNITURE_KIND_PARTS[piece.kind].length);
    }
    // a NON-container piece stays instanced (cheap) — it carries no individually tagged mesh.
    const bed = pieces.find((p) => p.kind === 'bed' && p.container === null);
    if (bed) expect(collectInteractableMeshes(root, grid.index(bed.cx, bed.cy)).length).toBe(0);
  });
});

describe('buildGround per-room floors', () => {
  it('splits a templated house floor into one tinted quad per room', () => {
    const { ctx, root } = ctxFor();
    const houses = ctx.town.placedHouses ?? [];
    expect(houses.length).toBeGreaterThan(0);
    // total distinct rooms across all houses.
    let totalRooms = 0;
    for (const h of houses) totalRooms += new Set(h.rooms.map((r) => r.roomId)).size;

    buildGround(ctx, { floorThicknessMeters: 0.1 });
    const floors = root.children.filter((c): c is Mesh => c instanceof Mesh);
    // 1 base ground plane + one floor quad per room (no single per-building slab for templated houses).
    expect(floors.length).toBe(1 + totalRooms);
  });
});
