// T87 — pure roof-shell geometry for the residential district. Builds gable / hip / flat roof BufferGeometry
// in LOCAL space (origin at the footprint centre, eave line at y = 0, ridge at y = pitch) so the caller can
// drop it at (centreX, wallTopY, centreZ) with no rotation. Eaves overhang the walls by `overhang` on every
// side for a believable residential read (ART-DIRECTION §4 — chunky readable massing). Normals are computed;
// callers render these with a DoubleSide MeshStandardMaterial so winding never produces a black inside face.
//
// Kept geometry-only + dependency-free (no registry/material) so it is trivially unit-testable and the scene
// owns tracking/disposal of whatever it builds from these (V24).

import { BufferGeometry, Float32BufferAttribute } from 'three';
import type { RoofShape } from '../../game/scene';

function build(positions: number[], indices: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/**
 * A pitched/flat roof shell over a `w` × `d` footprint rising `pitch` metres at the ridge, with `overhang`
 * eaves. `ridgeAlongX` orients a gable ridge (ignored for hip/flat). Local space: footprint centre at origin,
 * eaves at y = 0.
 */
export function makeRoofGeometry(
  shape: RoofShape,
  w: number,
  d: number,
  pitch: number,
  overhang: number,
  ridgeAlongX: boolean,
): BufferGeometry {
  const hx = w / 2 + overhang;
  const hz = d / 2 + overhang;

  if (shape === 'flat' || pitch <= 0) {
    // a single horizontal quad with a shallow lip (slight rise) so it still catches the key light.
    const y = Math.max(0, pitch);
    return build(
      [-hx, y, -hz, hx, y, -hz, hx, y, hz, -hx, y, hz],
      [0, 2, 1, 0, 3, 2],
    );
  }

  // base corners (eave line, y = 0): A(-hx,-hz) B(hx,-hz) C(hx,hz) D(-hx,hz)
  const A = [-hx, 0, -hz];
  const B = [hx, 0, -hz];
  const C = [hx, 0, hz];
  const D = [-hx, 0, hz];

  if (shape === 'gable') {
    if (ridgeAlongX) {
      const R0 = [-hx, pitch, 0];
      const R1 = [hx, pitch, 0];
      return build(
        [...A, ...B, ...C, ...D, ...R0, ...R1],
        [
          0, 1, 5, 0, 5, 4, // north slope (A,B,R1,R0)
          3, 5, 2, 3, 4, 5, // south slope (D,C,R1,R0)
          0, 4, 3, // west gable end (A,R0,D)
          1, 2, 5, // east gable end (B,C,R1)
        ],
      );
    }
    const R0 = [0, pitch, -hz];
    const R1 = [0, pitch, hz];
    return build(
      [...A, ...B, ...C, ...D, ...R0, ...R1],
      [
        1, 2, 5, 1, 5, 4, // east slope (B,C,R1,R0)
        3, 0, 4, 3, 4, 5, // west slope (D,A,R0,R1)
        0, 1, 4, // north gable end (A,B,R0)
        2, 3, 5, // south gable end (C,D,R1)
      ],
    );
  }

  // hip: ridge along the longer footprint axis, inset so the short ends become hip slopes.
  const alongX = w >= d;
  const rl = Math.max(0, (alongX ? w - d : d - w) / 2);
  if (alongX) {
    const R0 = [-rl, pitch, 0];
    const R1 = [rl, pitch, 0];
    return build(
      [...A, ...B, ...C, ...D, ...R0, ...R1],
      [
        0, 1, 5, 0, 5, 4, // north slope
        3, 5, 2, 3, 4, 5, // south slope
        0, 4, 3, // west hip end (A,R0,D)
        1, 2, 5, // east hip end (B,C,R1)
      ],
    );
  }
  const R0 = [0, pitch, -rl];
  const R1 = [0, pitch, rl];
  return build(
    [...A, ...B, ...C, ...D, ...R0, ...R1],
    [
      1, 2, 5, 1, 5, 4, // east slope
      3, 0, 4, 3, 4, 5, // west slope
      0, 1, 4, // north hip end (A,B,R0)
      2, 3, 5, // south hip end (C,D,R1)
    ],
  );
}
