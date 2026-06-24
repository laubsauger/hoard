// Furniture builder (P1c): a simple, readable BLOCKY mesh per placed furniture piece (furnishHouse →
// PlacedFurniture), oriented by the piece's `facing`, standing on the per-room interior floor slab. Every piece
// is composed of axis-aligned BOXES; to stay draw-call cheap the whole district's furniture is batched into ONE
// InstancedMesh PER COLOUR (a shared unit cube, scaled + rotated + placed per box) — a handful of draw calls for
// the entire street, the same instancing discipline propsBuilder uses. These meshes live INSIDE the houses, so
// they are interior CONTENT (added to the root, NOT registered as cutaway fade surfaces): they are hidden under
// the opaque roof and revealed when the cutaway fades the roof/upper wall, exactly like the interior floor +
// partition walls. Tracked for disposal (V24, via `res`). Cast + receive shadow. Pure static construction.

import { BoxGeometry, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import type { Edge, FurnitureKind } from '../../../game/scene';
import type { BuildContext } from './buildContext';

export interface FurnitureConfig {
  /** Y of the interior floor slab the furniture stands on (top of the per-room floor). */
  readonly floorThicknessMeters: number;
}

// ---------------------------------------------------------------------------------------------------------
// Per-kind blocky geometry (named consts — V4, no magic numbers buried in logic). Each piece is a list of BOXES
// in the piece's LOCAL frame: +x = right, +y = up (oy is the box CENTRE height above the floor), +z = the piece
// FRONT (the `facing` direction). Sizes in metres; a nav cell is 2 m so a piece sits comfortably inside its cell.
// ---------------------------------------------------------------------------------------------------------

/** Material palette (named tints) shared across kinds; batching keys off these so draw calls ≈ palette size. */
const C = {
  mattress: 0x9c8f79,
  pillow: 0xe8e4dc,
  woodLight: 0x6b4a2e,
  woodMid: 0x5a3d26,
  woodDark: 0x4a3320,
  upholsteryBlue: 0x55606b,
  upholsteryGrey: 0x5b5550,
  screen: 0x141414,
  applianceDark: 0x33352f,
  applianceWhite: 0xcfd2d4,
  porcelain: 0xe8eaec,
  counterTop: 0x8a8378,
  steel: 0xb8bcc0,
  metalShelf: 0x6a6a6a,
} as const;

interface Part {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly color: number;
}

const p = (sx: number, sy: number, sz: number, ox: number, oy: number, oz: number, color: number): Part => ({
  sx,
  sy,
  sz,
  ox,
  oy,
  oz,
  color,
});

/** A 4-legged table: a top slab + four leg posts under its corners. Reused by dining/coffee tables + workbench. */
function tableParts(w: number, d: number, topY: number, topColor: number, legColor: number): Part[] {
  const legH = topY - 0.06;
  const lx = w / 2 - 0.08;
  const lz = d / 2 - 0.08;
  return [
    p(w, 0.1, d, 0, topY, 0, topColor),
    p(0.08, legH, 0.08, lx, legH / 2, lz, legColor),
    p(0.08, legH, 0.08, -lx, legH / 2, lz, legColor),
    p(0.08, legH, 0.08, lx, legH / 2, -lz, legColor),
    p(0.08, legH, 0.08, -lx, legH / 2, -lz, legColor),
  ];
}

/** An upholstered seat (sofa/armchair): a seat block + a back slab along the rear (-z). */
function seatParts(w: number, color: number): Part[] {
  return [
    p(w, 0.45, 0.8, 0, 0.28, 0.05, color),
    p(w, 0.5, 0.22, 0, 0.55, -0.34, color),
  ];
}

const KIND_PARTS: Record<FurnitureKind, readonly Part[]> = {
  bed: [
    p(1.4, 0.4, 1.9, 0, 0.3, 0, C.mattress),
    p(1.2, 0.16, 0.4, 0, 0.58, -0.7, C.pillow), // pillow at the head (-z back)
  ],
  nightstand: [p(0.5, 0.5, 0.5, 0, 0.27, 0, C.woodLight)],
  dresser: [p(1.0, 0.8, 0.5, 0, 0.42, 0, C.woodMid)],
  wardrobe: [p(1.0, 1.9, 0.6, 0, 0.97, 0, C.woodDark)],
  sofa: seatParts(1.6, C.upholsteryBlue),
  armchair: seatParts(0.8, C.upholsteryGrey),
  coffeeTable: tableParts(1.0, 0.6, 0.42, C.woodLight, C.woodMid),
  tv: [
    p(0.8, 0.4, 0.4, 0, 0.22, 0, C.applianceDark), // stand
    p(1.1, 0.65, 0.08, 0, 0.78, 0.18, C.screen), // panel facing +z
  ],
  bookshelf: [p(1.0, 1.8, 0.4, 0, 0.92, 0, C.woodDark)],
  diningTable: tableParts(1.4, 1.0, 0.74, C.woodLight, C.woodMid),
  chair: [
    p(0.45, 0.1, 0.45, 0, 0.47, 0, C.woodMid), // seat
    p(0.45, 0.5, 0.1, 0, 0.72, -0.18, C.woodMid), // back
  ],
  sideboard: [p(1.4, 0.9, 0.5, 0, 0.47, 0, C.woodMid)],
  counter: [
    p(1.0, 0.84, 0.6, 0, 0.42, 0, C.woodLight), // cabinet body
    p(1.04, 0.08, 0.64, 0, 0.88, 0, C.counterTop), // worktop
  ],
  sink: [
    p(0.6, 0.8, 0.6, 0, 0.4, 0, C.steel),
    p(0.62, 0.06, 0.62, 0, 0.83, 0, C.porcelain), // basin lip
  ],
  stove: [
    p(1.0, 0.84, 0.6, 0, 0.42, 0, C.applianceDark),
    p(1.0, 0.06, 0.6, 0, 0.88, 0, C.steel), // cooktop
  ],
  fridge: [p(0.9, 1.9, 0.7, 0, 0.97, 0, C.applianceWhite)],
  toilet: [
    p(0.5, 0.45, 0.6, 0, 0.25, 0.05, C.porcelain), // bowl
    p(0.5, 0.5, 0.2, 0, 0.55, -0.2, C.porcelain), // cistern at the back
  ],
  bathtub: [p(1.7, 0.6, 0.8, 0, 0.32, 0, C.porcelain)],
  medicineCabinet: [p(0.5, 0.6, 0.18, 0, 1.3, 0, C.applianceWhite)], // wall-mounted, high
  workbench: tableParts(1.6, 0.7, 0.86, C.applianceDark, C.woodDark),
  shelving: [p(1.0, 1.8, 0.5, 0, 0.92, 0, C.metalShelf)],
  washer: [p(0.7, 0.9, 0.7, 0, 0.47, 0, C.applianceWhite)],
  console: [p(1.0, 0.8, 0.35, 0, 0.42, 0, C.woodMid)],
};

/** Y rotation that turns the LOCAL +z (piece front) toward the world `facing` edge. +x = east, +z = south
 *  (cy increases southward, matching worldToCell). rotateY(θ): (0,0,1) → (sinθ,0,cosθ). */
const FACING_ROT: Record<Edge, number> = {
  s: 0,
  e: Math.PI / 2,
  n: Math.PI,
  w: -Math.PI / 2,
};

export function buildFurniture(ctx: BuildContext, cfg: FurnitureConfig): void {
  const { root, res, town, navCellSize: cs } = ctx;
  const furniture = town.placedFurniture;
  if (!furniture || furniture.length === 0) return;

  // batch every box by colour → one InstancedMesh per colour (shared unit cube, transformed per box).
  const byColor = new Map<number, Matrix4[]>();
  const _pos = new Vector3();
  const _q = new Quaternion();
  const _scale = new Vector3();
  const _off = new Vector3();
  const yUp = new Vector3(0, 1, 0);

  for (const piece of furniture) {
    const parts = KIND_PARTS[piece.kind];
    const rot = FACING_ROT[piece.facing];
    _q.setFromAxisAngle(yUp, rot);
    // world centre of the piece's anchor cell (1x1 footprint → the cell centre is the piece centre).
    const wx = (piece.cx + (piece.footprint.w) / 2) * cs;
    const wz = (piece.cy + (piece.footprint.d) / 2) * cs;
    for (const part of parts) {
      // rotate the local offset into world, then add the cell centre + the floor base height.
      _off.set(part.ox, 0, part.oz).applyQuaternion(_q);
      _pos.set(wx + _off.x, cfg.floorThicknessMeters + part.oy, wz + _off.z);
      _scale.set(part.sx, part.sy, part.sz);
      const m = new Matrix4().compose(_pos.clone(), _q.clone(), _scale.clone());
      const list = byColor.get(part.color) ?? [];
      list.push(m);
      byColor.set(part.color, list);
    }
  }

  const unit = res.geo('furniture.unitBox', new BoxGeometry(1, 1, 1));
  for (const [colorHex, mats] of byColor) {
    if (mats.length === 0) continue;
    const mat = res.mat(`furniture.${colorHex.toString(16)}`, { color: colorHex, roughness: 0.85 });
    const mesh = new InstancedMesh(unit, mat, mats.length);
    res.track(mesh, 'buffer', `furniture.${colorHex.toString(16)}.instanced`);
    for (let i = 0; i < mats.length; i++) mesh.setMatrixAt(i, mats[i]!);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
}

/** Re-exported for tests / tools (the palette + kind table are the readable source of truth). */
export { KIND_PARTS as FURNITURE_KIND_PARTS, FACING_ROT as FURNITURE_FACING_ROT, C as FURNITURE_COLORS };
