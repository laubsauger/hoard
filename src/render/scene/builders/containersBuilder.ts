// Containers builder: lootable kitchen-cupboard meshes (T85) — one wood-toned cabinet at each authored
// container cell (the same `lootableContainerCells` source the runtime anchors the interactable to, so the
// visible cabinet and the hotspot coincide). Dims from typed structures config (V4). Pure static construction.
// Extracted from BlockScene (docs/REFACTOR-godfiles.md).

import { BoxGeometry, Group, Mesh } from 'three';
import { lootableContainerCells } from '../../../game/scene';
import type { BuildContext } from './buildContext';

export interface ContainersConfig {
  readonly cupboardWidthMeters: number;
  readonly cupboardHeightMeters: number;
  readonly cupboardDepthMeters: number;
  /** Y of the interior floor slab the cabinets stand on. */
  readonly floorThicknessMeters: number;
}

export function buildContainers(ctx: BuildContext, cfg: ContainersConfig): void {
  const { root, res, town } = ctx;
  const placements = lootableContainerCells(town);
  if (placements.length === 0) return;
  const w = cfg.cupboardWidthMeters;
  const h = cfg.cupboardHeightMeters;
  const d = cfg.cupboardDepthMeters;
  const floorY = cfg.floorThicknessMeters;
  // Shared materials + geometries across every cabinet (one wood body tone + a darker door/face + brass pulls).
  const bodyMat = res.mat('cupboard.body', { color: 0x6b4a2e, roughness: 0.78 });
  const faceMat = res.mat('cupboard.face', { color: 0x573a23, roughness: 0.7 });
  const topMat = res.mat('cupboard.top', { color: 0x8a8378, roughness: 0.55 });
  const pullMat = res.mat('cupboard.pull', { color: 0xb9a05a, roughness: 0.4, metalness: 0.6 });
  const topThick = Math.min(0.06, h * 0.1);
  const bodyGeo = res.geo('cupboard.body.geo', new BoxGeometry(w, h - topThick, d));
  const topGeo = res.geo('cupboard.top.geo', new BoxGeometry(w + 0.06, topThick, d + 0.06));
  const doorGeo = res.geo('cupboard.door.geo', new BoxGeometry(w * 0.46, (h - topThick) * 0.86, 0.03));
  const pullGeo = res.geo('cupboard.pull.geo', new BoxGeometry(0.03, 0.12, 0.04));
  const group = new Group();
  for (const placement of placements) {
    const c = town.cellCenter(placement.cell);
    const bodyCy = floorY + (h - topThick) / 2;
    const body = new Mesh(bodyGeo, bodyMat);
    body.position.set(c.x, bodyCy, c.z);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    const top = new Mesh(topGeo, topMat);
    top.position.set(c.x, floorY + h - topThick / 2, c.z);
    top.castShadow = true;
    group.add(top);
    // two front door panels (toward +Z) with a centre reveal + a brass pull on each.
    const faceZ = c.z + d / 2 + 0.015;
    for (const sx of [-1, 1] as const) {
      const door = new Mesh(doorGeo, faceMat);
      door.position.set(c.x + sx * w * 0.24, bodyCy, faceZ);
      group.add(door);
      const pull = new Mesh(pullGeo, pullMat);
      pull.position.set(c.x + sx * w * 0.04, bodyCy, faceZ + 0.02);
      group.add(pull);
    }
  }
  root.add(group);
}
