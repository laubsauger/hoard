// T40 — the objective RADIO mesh: one small ham-radio set on a low stand at the authored `radioCell` (the SAME
// single source of truth the runtime anchors the radio interactable to, so the visible set and the hotspot
// coincide — mirrors containersBuilder). Tagged interactable by nav cell so the active-interactable silhouette
// glow (T113/V79) hugs the radio shape. Pure static construction; dims derive from the cupboard config (V4).

import { BoxGeometry, CylinderGeometry, Group, Mesh } from 'three';
import { radioCell } from '../../../game/scene';
import { tagInteractable } from '../../effects/highlightView';
import type { BuildContext } from './buildContext';

export interface RadioConfig {
  /** Reuse the cupboard footprint to size the radio + its stand (no separate config key needed). */
  readonly cupboardWidthMeters: number;
  readonly cupboardHeightMeters: number;
  readonly cupboardDepthMeters: number;
  /** Y of the interior floor slab the stand rests on. */
  readonly floorThicknessMeters: number;
}

export function buildRadio(ctx: BuildContext, cfg: RadioConfig): void {
  const { root, res, town } = ctx;
  const placement = radioCell(town);
  const c = town.cellCenter(placement.cell);
  const navCell = town.navGrid.index(placement.cell.cx, placement.cell.cy);
  const floorY = cfg.floorThicknessMeters;

  // A waist-high stand carrying a boxy set with a dish/antenna — small, distinct from the wood cupboards.
  const standH = cfg.cupboardHeightMeters * 0.5;
  const standW = cfg.cupboardWidthMeters * 0.5;
  const standD = cfg.cupboardDepthMeters * 0.7;
  const setW = standW * 0.9;
  const setH = cfg.cupboardHeightMeters * 0.3;
  const setD = standD * 0.8;

  const standMat = res.mat('radio.stand', { color: 0x3a3f44, roughness: 0.7 });
  const bodyMat = res.mat('radio.body', { color: 0x2b6f6a, roughness: 0.45, metalness: 0.3 });
  const dialMat = res.mat('radio.dial', { color: 0xd8b24a, roughness: 0.4, metalness: 0.5 });
  const antMat = res.mat('radio.antenna', { color: 0x9aa0a6, roughness: 0.3, metalness: 0.7 });

  const standGeo = res.geo('radio.stand.geo', new BoxGeometry(standW, standH, standD));
  const bodyGeo = res.geo('radio.body.geo', new BoxGeometry(setW, setH, setD));
  const dialGeo = res.geo('radio.dial.geo', new BoxGeometry(setW * 0.5, setH * 0.5, 0.02));
  const antGeo = res.geo('radio.antenna.geo', new CylinderGeometry(0.015, 0.015, setH * 1.6, 6));

  const group = new Group();
  const standCy = floorY + standH / 2;
  const stand = new Mesh(standGeo, standMat);
  stand.position.set(c.x, standCy, c.z);
  stand.castShadow = true;
  stand.receiveShadow = true;
  tagInteractable(stand, navCell);
  group.add(stand);

  const setCy = floorY + standH + setH / 2;
  const body = new Mesh(bodyGeo, bodyMat);
  body.position.set(c.x, setCy, c.z);
  body.castShadow = true;
  tagInteractable(body, navCell);
  group.add(body);

  // A face dial toward +Z (the player approaches from the room side) + a stubby antenna up the back.
  const dial = new Mesh(dialGeo, dialMat);
  dial.position.set(c.x, setCy, c.z + setD / 2 + 0.011);
  tagInteractable(dial, navCell);
  group.add(dial);

  const antenna = new Mesh(antGeo, antMat);
  antenna.position.set(c.x + setW * 0.35, floorY + standH + setH + setH * 0.6, c.z - setD * 0.3);
  tagInteractable(antenna, navCell);
  group.add(antenna);

  root.add(group);
}
