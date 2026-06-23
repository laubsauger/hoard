// Ground builder: the base district verge, per-building interior floor slabs, and the suburban ground paint
// (asphalt street / concrete sidewalk / grass yards). Pure static construction — adds meshes to the root and
// returns nothing (no per-frame handle). Extracted from BlockScene (docs/REFACTOR-godfiles.md).

import { Group, Mesh, PlaneGeometry } from 'three';
import type { MeshStandardMaterial } from 'three';
import { buildingsOf, type GroundKind } from '../../../game/scene';
import { worldExtent, type BuildContext } from './buildContext';

export interface GroundConfig {
  /** Y of the per-building interior floor slab (so rooms read above the base ground). */
  readonly floorThicknessMeters: number;
}

export function buildGround(ctx: BuildContext, cfg: GroundConfig): void {
  const { root, res, town, navCellSize } = ctx;
  const { width, depth } = worldExtent(town, navCellSize);
  const margin = navCellSize * 4;
  // Base ground = grass/dirt verge under the whole district; the suburban paint is layered on top below.
  const ground = new Mesh(
    res.geo('ground.geo', new PlaneGeometry(width + margin, depth + margin)),
    res.mat('ground', { color: 0x57564a, roughness: 0.98 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(width / 2, 0, depth / 2);
  ground.receiveShadow = true;
  root.add(ground);

  // Per-building interior floor slab — slightly raised + lighter so each house's rooms read (multi-building).
  const floorMat = res.mat('floor', { color: 0x6b6e64, roughness: 0.9 });
  buildingsOf(town).forEach((bld, i) => {
    const b = bld.bounds;
    const fw = (b.maxCx - b.minCx + 1) * navCellSize;
    const fd = (b.maxCy - b.minCy + 1) * navCellSize;
    const floor = new Mesh(res.geo(`floor.geo.${i}`, new PlaneGeometry(fw, fd)), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(((b.minCx + b.maxCx + 1) / 2) * navCellSize, cfg.floorThicknessMeters, ((b.minCy + b.maxCy + 1) / 2) * navCellSize);
    floor.receiveShadow = true;
    root.add(floor);
  });
}

/** Suburban ground paint (T87): asphalt street, concrete sidewalk, grass yards as flat coloured quads layered
 *  by a small per-kind Y offset (highest kind wins on overlap). Pure dressing; no nav effect. */
export function buildGroundRects(ctx: BuildContext): void {
  const { root, res, town, navCellSize: cs } = ctx;
  const rects = town.groundRects;
  if (!rects || rects.length === 0) return;
  const color: Record<GroundKind, number> = { asphalt: 0x26282c, sidewalk: 0x6a6c6e, grass: 0x3b4a2c };
  const yOf: Record<GroundKind, number> = { asphalt: 0.012, sidewalk: 0.02, grass: 0.028 };
  const mats: Record<GroundKind, MeshStandardMaterial> = {
    asphalt: res.mat('ground.asphalt', { color: color.asphalt, roughness: 0.96 }),
    sidewalk: res.mat('ground.sidewalk', { color: color.sidewalk, roughness: 0.9 }),
    grass: res.mat('ground.grass', { color: color.grass, roughness: 1 }),
  };
  const group = new Group();
  rects.forEach((r, i) => {
    const w = (r.rect.maxCx - r.rect.minCx + 1) * cs;
    const d = (r.rect.maxCy - r.rect.minCy + 1) * cs;
    const m = new Mesh(res.geo(`groundRect.${i}`, new PlaneGeometry(w, d)), mats[r.kind]);
    m.rotation.x = -Math.PI / 2;
    m.position.set(((r.rect.minCx + r.rect.maxCx + 1) / 2) * cs, yOf[r.kind], ((r.rect.minCy + r.rect.maxCy + 1) / 2) * cs);
    m.receiveShadow = true;
    group.add(m);
  });
  root.add(group);
}
