// Ground builder: the base district verge, per-building interior floor slabs, and the suburban ground paint
// (asphalt street / concrete sidewalk / grass yards). Pure static construction — adds meshes to the root and
// returns nothing (no per-frame handle). Extracted from BlockScene (docs/REFACTOR-godfiles.md).

import { Group, Mesh, PlaneGeometry } from 'three';
import type { MeshStandardMaterial } from 'three';
import { buildingsOf, type GroundKind, type RoomType } from '../../../game/scene';
import { worldExtent, type BuildContext } from './buildContext';

export interface GroundConfig {
  /** Y of the per-building interior floor slab (so rooms read above the base ground). */
  readonly floorThicknessMeters: number;
}

/** Per-room-type FLOOR tint (P1c). Kitchen/bath read as cool tile; bedroom/living/dining as warm carpet/wood;
 *  garage/laundry as concrete; hall/closet neutral wood. Distinct flat colours so each room reads as its own
 *  space in the cutaway — no texture files, pure material (V4 named consts, no magic numbers in logic). */
const ROOM_FLOOR_COLOR: Record<RoomType, number> = {
  kitchen: 0x9aa7a3, // light cool tile
  bathroom: 0xa7b0b5, // cool tile
  bedroom: 0x7a6552, // warm carpet
  living: 0x8a6a45, // warm wood
  dining: 0x7d5d3c, // wood
  hall: 0x6f6052, // neutral wood
  garage: 0x595a57, // bare concrete
  closet: 0x6b5a48, // wood
  laundry: 0x8f9690, // utility tile
};

export function buildGround(ctx: BuildContext, cfg: GroundConfig): void {
  const { root, res, town, navCellSize } = ctx;
  const { width, depth } = worldExtent(town, navCellSize);
  const margin = navCellSize * 4;
  // Base ground = grass/dirt verge under the whole district; the suburban paint is layered on top below.
  const ground = new Mesh(
    res.geo('ground.geo', new PlaneGeometry(width + margin, depth + margin)),
    // polygonOffset pushes the base verge BACK in depth so the suburban paint layered on top never z-fights it
    // (the layers are near-coplanar — tiny Y gaps alone aren't enough at iso distance; the depth bias is). A big
    // bias (4) is needed because at far zoom the depth buffer loses precision and a small bias washed out → the
    // near-black asphalt paint started z-fighting this dark base verge.
    res.mat('ground', { color: 0x57564a, roughness: 0.98, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(width / 2, 0, depth / 2);
  ground.receiveShadow = true;
  root.add(ground);

  // Per-building interior floor slab. For a templated house (P1c) the slab is SPLIT PER ROOM, each tinted by its
  // RoomType so the cutaway reveals each room as its own space; non-templated buildings keep one neutral slab.
  const floorMat = res.mat('floor', { color: 0x6b6e64, roughness: 0.9 });
  const roomFloorMat: Partial<Record<RoomType, MeshStandardMaterial>> = {};
  buildingsOf(town).forEach((bld, i) => {
    const b = bld.bounds;
    const house = town.placedHouses?.[i];
    if (house) {
      // group the house's cells into per-room inclusive rects, then one tinted quad per room.
      const rects = new Map<number, { minCx: number; minCy: number; maxCx: number; maxCy: number; type: RoomType }>();
      for (const rc of house.rooms) {
        const r = rects.get(rc.roomId);
        if (!r) rects.set(rc.roomId, { minCx: rc.cx, minCy: rc.cy, maxCx: rc.cx, maxCy: rc.cy, type: rc.type });
        else {
          r.minCx = Math.min(r.minCx, rc.cx);
          r.minCy = Math.min(r.minCy, rc.cy);
          r.maxCx = Math.max(r.maxCx, rc.cx);
          r.maxCy = Math.max(r.maxCy, rc.cy);
        }
      }
      for (const [roomId, r] of rects) {
        const mat =
          roomFloorMat[r.type] ??
          (roomFloorMat[r.type] = res.mat(`floor.room.${r.type}`, { color: ROOM_FLOOR_COLOR[r.type], roughness: 0.92 }));
        const fw = (r.maxCx - r.minCx + 1) * navCellSize;
        const fd = (r.maxCy - r.minCy + 1) * navCellSize;
        const floor = new Mesh(res.geo(`floor.geo.${i}.${roomId}`, new PlaneGeometry(fw, fd)), mat);
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(((r.minCx + r.maxCx + 1) / 2) * navCellSize, cfg.floorThicknessMeters, ((r.minCy + r.maxCy + 1) / 2) * navCellSize);
        floor.receiveShadow = true;
        root.add(floor);
      }
      return;
    }
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
  const yOf: Record<GroundKind, number> = { asphalt: 0.02, sidewalk: 0.05, grass: 0.08 };
  // Each paint layer gets a distinct polygonOffset (more negative = wins the depth test) so abutting/overlapping
  // layers (street↔sidewalk, sidewalk↔lawn) never z-fight — the depth bias orders them deterministically beyond
  // what the small Y gaps can do at iso distance. Higher kind wins on overlap (grass over sidewalk over asphalt).
  const off: Record<GroundKind, number> = { asphalt: -1, sidewalk: -2, grass: -3 };
  const mat = (kind: GroundKind, roughness: number): MeshStandardMaterial =>
    res.mat(`ground.${kind}`, { color: color[kind], roughness, polygonOffset: true, polygonOffsetFactor: off[kind], polygonOffsetUnits: off[kind] });
  const mats: Record<GroundKind, MeshStandardMaterial> = {
    asphalt: mat('asphalt', 0.96),
    sidewalk: mat('sidewalk', 0.9),
    grass: mat('grass', 1),
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
