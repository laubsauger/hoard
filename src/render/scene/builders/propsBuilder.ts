// Props builder: decorative district dressing (T87) — picket fences in varied disarray, abandoned cars,
// tires, bushes, live + dead trees. EVERY repeated prop is ONE InstancedMesh per batch so the whole district
// stays draw-call-cheap (≈1 call/kind). Per-span fence/tree decay is derived deterministically from the
// prop's cell (V26). Pure static construction. Extracted from BlockScene (docs/REFACTOR-godfiles.md).

import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type MeshStandardMaterial,
} from 'three';
import { hash01 } from '../../../game/scene';
import type { BuildContext } from './buildContext';

export interface PropsConfig {
  readonly fenceMissingChance: number;
  readonly fenceBrokenChance: number;
  readonly fenceLeanMaxRadians: number;
  readonly treeDeadChance: number;
}

export function buildProps(ctx: BuildContext, cfg: PropsConfig): void {
  const { root, res, town, navCellSize: cs } = ctx;
  const props = town.props;
  if (!props || props.length === 0) return;
  const group = new Group();

  const B = {
    fence: [] as Matrix4[],
    tire: [] as Matrix4[],
    bush: [] as Matrix4[],
    trunkLive: [] as Matrix4[],
    foliage: [] as Matrix4[],
    trunkDead: [] as Matrix4[],
    branch: [] as Matrix4[],
    carBody: [] as Matrix4[],
    carCabin: [] as Matrix4[],
  };
  const bushColors: Color[] = [];

  const _p = new Vector3();
  const _q = new Quaternion();
  const _s = new Vector3();
  const _e = new Euler();
  const mk = (x: number, y: number, z: number, rotY: number, tiltX: number, sx: number, sy: number, sz: number): Matrix4 =>
    new Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(tiltX, rotY, 0)), _s.set(sx, sy, sz));

  for (const p of props) {
    const rot = p.rot ?? 0;
    const variant = p.variant ?? 0;
    const x = (p.cx + 0.5) * cs;
    const z = (p.cy + 0.5) * cs;
    const seed = (Math.imul(p.cx + 1, 73856093) ^ Math.imul(p.cy + 1, 19349663)) | 0;
    switch (p.kind) {
      case 'fence': {
        if (hash01(seed, 5000) < cfg.fenceMissingChance) break; // missing span → a gap in the run
        const broken = hash01(seed, 5001) < cfg.fenceBrokenChance;
        const tilt = (hash01(seed, 5002) - 0.5) * 2 * cfg.fenceLeanMaxRadians;
        const sy = broken ? 0.55 : 1;
        B.fence.push(mk(x, 0.5 * sy, z, rot, tilt, 1, sy, 1));
        break;
      }
      case 'tire':
        B.tire.push(mk(x, 0.19, z, rot + variant, 0, 1, 1, 1));
        break;
      case 'bush': {
        const s = 0.8 + variant * 0.25;
        B.bush.push(mk(x, 0.5 * s, z, rot, 0, s, s * 0.8, s));
        bushColors.push(new Color(0x33491f).offsetHSL(0, 0, (hash01(seed, 1) - 0.5) * 0.12));
        break;
      }
      case 'tree': {
        const s = 1 + variant * 0.3;
        if (hash01(seed, 22) < cfg.treeDeadChance) {
          const tilt = (hash01(seed, 24) - 0.5) * 0.5;
          B.trunkDead.push(mk(x, 1.1, z, 0, tilt, 1, 1, 1));
          for (let br = 0; br < 3; br++) {
            const ang = hash01(seed, 10 + br) * Math.PI * 2;
            B.branch.push(mk(x, 1.9 + br * 0.3, z, ang, 0.7 + tilt, 1, 1, 1));
          }
        } else {
          B.trunkLive.push(mk(x, 1.1, z, 0, 0, 1, 1, 1));
          B.foliage.push(mk(x, 2.6, z, hash01(seed, 7) * Math.PI, 0, s, s, s));
        }
        break;
      }
      case 'car': {
        B.carBody.push(mk(x, 0.55, z, rot, 0, 1, 1, 1));
        B.carCabin.push(mk(x, 1.3, z, rot, 0, 1, 1, 1));
        break;
      }
    }
  }

  const flush = (label: string, geo: BufferGeometry, mat: MeshStandardMaterial, mats: Matrix4[], colors?: Color[]): void => {
    if (mats.length === 0) return;
    const mesh = new InstancedMesh(geo, mat, mats.length);
    res.track(mesh, 'buffer', `prop.${label}.instanced`);
    for (let i = 0; i < mats.length; i++) mesh.setMatrixAt(i, mats[i]!);
    if (colors) {
      for (let i = 0; i < colors.length; i++) mesh.setColorAt(i, colors[i]!);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  // shared geometries (length along X for the fence; tire baked flat) + weathered materials.
  const fenceGeo = res.geo('prop.fence.geo', new BoxGeometry(cs * 0.92, 1.0, 0.08));
  const tireGeo = res.geo('prop.tire.geo', new CylinderGeometry(0.34, 0.34, 0.38, 12).rotateX(Math.PI / 2));
  const bushGeo = res.geo('prop.bush.geo', new IcosahedronGeometry(0.75, 0));
  const trunkGeo = res.geo('prop.trunk.geo', new CylinderGeometry(0.18, 0.24, 2.2, 7));
  const foliageGeo = res.geo('prop.foliage.geo', new IcosahedronGeometry(1.5, 0));
  const branchGeo = res.geo('prop.branch.geo', new BoxGeometry(0.08, 1.2, 0.08));
  const carBodyGeo = res.geo('prop.carBody.geo', new BoxGeometry(2.0, 0.9, 4.2));
  const carCabinGeo = res.geo('prop.carCabin.geo', new BoxGeometry(1.8, 0.8, 2.0));

  flush('fence', fenceGeo, res.mat('prop.fence', { color: 0x6b5a44, roughness: 0.95 }), B.fence);
  flush('tire', tireGeo, res.mat('prop.tire', { color: 0x161616, roughness: 0.95 }), B.tire);
  flush('bush', bushGeo, res.mat('prop.bush', { color: 0xffffff, roughness: 1 }), B.bush, bushColors);
  flush('trunkLive', trunkGeo, res.mat('prop.trunk', { color: 0x39281a, roughness: 0.95 }), B.trunkLive);
  flush('foliage', foliageGeo, res.mat('prop.foliage', { color: 0x2c4a24, roughness: 1 }), B.foliage);
  flush('trunkDead', trunkGeo, res.mat('prop.trunkDead', { color: 0x4a443a, roughness: 0.95 }), B.trunkDead);
  flush('branch', branchGeo, res.mat('prop.branch', { color: 0x4a443a, roughness: 0.95 }), B.branch);
  flush('carBody', carBodyGeo, res.mat('prop.carBody', { color: 0x5a5247, roughness: 0.7, metalness: 0.2 }), B.carBody);
  flush('carCabin', carCabinGeo, res.mat('prop.carCabin', { color: 0x2b3036, roughness: 0.5, metalness: 0.2 }), B.carCabin);

  root.add(group);
}
