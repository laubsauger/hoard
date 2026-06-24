// House builder: the per-building shell (T87) — perimeter base/upper walls, destructible §G section meshes,
// horizontal clapboard siding, shaped roof + chimney + decay holes, front porch, and the shared instanced ivy
// + debris dressing for the whole district. Returns HouseHandles (fade surfaces + section meshes) the cutaway
// and breach systems consume per-frame. Pure static construction. Extracted from BlockScene
// (docs/REFACTOR-godfiles.md). The fade-surface PUSH ORDER (per building: upper-wall sides → roof → interior
// partition walls) is load-bearing — blockScene.test asserts the surface indices/counts.

import {
  BoxGeometry,
  Color,
  DoubleSide,
  Euler,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { color, float, fract, positionWorld, smoothstep, step } from 'three/tsl';
import {
  buildingsOf,
  roofHoles,
  hash01,
  windowPlacements,
  type HouseStyle,
  type CellRect,
  type PlacedHouse,
} from '../../../game/scene';
import {
  windowOpeningHeightMeters,
  windowOpeningSpanMeters,
  windowSillHeights,
} from './windowGeometry';
import type { NavGrid } from '../../../game/navigation';
import {
  resolveCutawayDepthOffset,
  type CutawayDepthSettings,
  type VecXZ,
  type VisibilitySettings,
} from '../../world/visibility';
import { makeRoofGeometry } from '../houseGeometry';
import { tagInteractable } from '../../effects/highlightView';
import { worldConfig } from '../../../config/domains/world';
import type { ResolvedDomain } from '../../../config/types';
import type { BuildContext } from './buildContext';
import type { FadeSurface, HouseHandles, SectionMesh } from './handles';
import type { HouseStyleResolver } from './houseStyle';

// ---- collapsed-roof sag (house polish #8) — a caved roof tilts about Z, but the tilt must NEVER dip the low
// eave BELOW the wall plate (walls poking through above the roof). The sag is a gentle, fixed tilt; the group
// is then LIFTED by the low eave's vertical drop (hx·sin θ) so that eave lands exactly on the wall top. Named
// consts (V4 — no magic tilt literal). ----
/** Collapsed-roof tilt about Z (radians). Gentle enough to read as a sagging caved roof without a steep slab. */
const COLLAPSED_ROOF_SAG_RADIANS = 0.1;
/** How far OUT from the wall face (m) foundation plants sit — into the yard, not merged into the wall plane. */
const IVY_YARD_OFFSET_METERS = 0.4;

// ---- procedural asphalt-shingle roof (house polish #6) — no texture files: a TSL colorNode that bands the
// roof tint into horizontal shingle COURSES (dark seam every `course` m of world Y, like the cladding grooves),
// vertical TAB seams (every `tab` m of world X), and a faint alternating per-course TINT so rows read as
// offset shingle strips rather than one flat colour. Subtle + believable; all params are named consts (V4). ----
/** Vertical spacing of a shingle course (world metres). */
const ROOF_SHINGLE_COURSE_METERS = 0.55;
/** Horizontal spacing of a shingle tab seam (world metres). */
const ROOF_SHINGLE_TAB_METERS = 0.95;
/** Darkening of the shadow groove at each course / tab seam (0..1, tint multiplied down). */
const ROOF_SHINGLE_GROOVE_DARKEN = 0.32;
/** Groove thickness as a fraction of one course / tab. */
const ROOF_SHINGLE_GROOVE_WIDTH_RATIO = 0.16;
/** Faint extra darkening applied to every other course so rows read as distinct shingle strips. */
const ROOF_SHINGLE_ROW_TINT = 0.06;

/**
 * The shingle roof `colorNode` (TSL): the per-house roof tint with horizontal course seams + vertical tab seams
 * cut in as shadow grooves, plus an alternating per-course darken so the roof reads as stacked asphalt-shingle
 * strips. Banded by WORLD position (continuous across the merged roof + decay holes). Pure node construction.
 */
function roofShingleColorNode(roofColorHex: number) {
  const base = color(roofColorHex);
  // horizontal course seam: 0 at a course line, rising past the groove.
  const fy = fract(positionWorld.y.div(ROOF_SHINGLE_COURSE_METERS));
  const courseSeam = float(1).sub(smoothstep(0, ROOF_SHINGLE_GROOVE_WIDTH_RATIO, fy)).mul(ROOF_SHINGLE_GROOVE_DARKEN);
  // vertical tab seam along world X.
  const fx = fract(positionWorld.x.div(ROOF_SHINGLE_TAB_METERS));
  const tabSeam = float(1).sub(smoothstep(0, ROOF_SHINGLE_GROOVE_WIDTH_RATIO, fx)).mul(ROOF_SHINGLE_GROOVE_DARKEN);
  // alternating row tint: every other course darkened a hair (step at the half-mark of a 2-course band).
  const rowSel = step(0.5, fract(positionWorld.y.div(ROOF_SHINGLE_COURSE_METERS * 2)));
  const rowDark = rowSel.mul(ROOF_SHINGLE_ROW_TINT);
  // combine the darkenings (take the strongest seam so crossing grooves don't double-darken to black).
  const seam = courseSeam.max(tabSeam);
  return base.mul(float(1).sub(seam).sub(rowDark));
}

export interface HouseConfig {
  /** Resolved world domain (building wall height, porch depth, etc). */
  readonly world: ResolvedDomain<typeof worldConfig>;
  /** Surface-visibility settings (base opaque wall height, cutaway thresholds). */
  readonly visibility: VisibilitySettings;
  /** Cutaway depth-offset settings (polygon offset / render order for fading upper walls + roofs). */
  readonly cutawayDepth: CutawayDepthSettings;
  readonly wallPanelThickness: number;
  /** Place a window on every Nth eligible facade cell (world.houseWindowStride) — same source openingsBuilder uses. */
  readonly houseWindowStride: number;
  /** Fraction of facade windows that start boarded over (world.houseWindowBoardedFraction). */
  readonly windowBoardedFraction: number;
  readonly clapboardSpacing: number;
  /** Darken amount of the lap-siding shadow groove at each board seam (TSL wall colorNode). */
  readonly clapboardGrooveDarken: number;
  /** Width of the shadow groove as a fraction of one board spacing. */
  readonly clapboardGrooveWidthRatio: number;
  readonly roofOverhang: number;
  readonly chimneyMeters: number;
  readonly porchHeightMeters: number;
  readonly ivyInstanceCap: number;
  readonly ivyPatchMeters: number;
  readonly debrisMeters: number;
  readonly houseDebrisMaxCount: number;
}

/**
 * The cardinal OUTWARD horizontal normal of an upper-wall panel (T82/V58). For a panel running along X the
 * normal is ±Z (the open/exterior side); along Z it is ±X. A perimeter wall has exactly one open side so
 * the exposed-edge sign decides; a free-standing interior wall (open on both sides) falls back to pointing
 * away from the building centre. Pure helper — feeds the directional cutaway's per-side fade buckets.
 */
export function upperWallOutwardNormal(
  along: 'x' | 'z',
  faces: { dx: number; dz: number; along: 'x' | 'z' }[],
  wx: number,
  wz: number,
  centerX: number,
  centerZ: number,
): VecXZ {
  if (along === 'x') {
    const north = faces.some((f) => f.along === 'x' && f.dz < 0);
    const south = faces.some((f) => f.along === 'x' && f.dz > 0);
    const sz = north && !south ? -1 : south && !north ? 1 : wz < centerZ ? -1 : 1;
    return { x: 0, z: sz };
  }
  const west = faces.some((f) => f.along === 'z' && f.dx < 0);
  const east = faces.some((f) => f.along === 'z' && f.dx > 0);
  const sx = west && !east ? -1 : east && !west ? 1 : wx < centerX ? -1 : 1;
  return { x: sx, z: 0 };
}

/**
 * The wall cladding `colorNode` (TSL): the per-house tint with a thin horizontal lap-siding shadow groove cut
 * into it every `spacing` metres of WORLD Y, so a SINGLE solid wall surface reads as stacked siding boards
 * (no separate cladding geometry). `positionWorld.y` keeps the banding continuous across the base + upper wall
 * split and across merged panels. `darken` is the groove depth (0..1, tint multiplied down); `widthRatio` is the
 * groove thickness as a fraction of one board. Pure node construction — compiles at render, no GPU needed here.
 */
function claddingColorNode(
  wallColorHex: number,
  spacing: number,
  darken: number,
  widthRatio: number,
) {
  const base = color(wallColorHex);
  // fract(y / spacing): 0 at a board seam, rising to ~1 just below the next seam.
  const f = fract(positionWorld.y.div(spacing));
  // smoothstep(0 → widthRatio) is 0 at the seam and 1 past the groove; invert so the seam is the dark line.
  const seamDark = float(1).sub(smoothstep(0, widthRatio, f)).mul(darken);
  return base.mul(float(1).sub(seamDark));
}

/** Interior partition tint: the house wall colour lightened toward plaster white, so room dividers read as
 *  painted interior walls while still belonging to the house (V59). Pure. */
function interiorWallColor(wallColorHex: number): number {
  return new Color(wallColorHex).lerp(new Color(0xffffff), 0.6).getHex();
}

const EXT_DIR_DELTA: Record<'n' | 's' | 'e' | 'w', { dx: number; dy: number }> = {
  n: { dx: 0, dy: -1 },
  s: { dx: 0, dy: 1 },
  e: { dx: 1, dy: 0 },
  w: { dx: -1, dy: 0 },
};

/** The OUTWARD direction (n/s/e/w) of an EXTERIOR wall edge: the side whose neighbour cell is OUTSIDE the
 *  footprint (roomAt → null). A template footprint is a full W×D rectangle (depth ≥ 2 everywhere), so a boundary
 *  cell is exterior on at most one of its N/S faces and one of its E/W faces — no n↔s (or e↔w) ambiguity. The
 *  edge's `along` axis ('x' = N/S face, 'z' = E/W face) picks which pair to test. WORLD coords throughout. */
function exteriorEdgeDir(house: PlacedHouse, innerCx: number, innerCy: number, along: 'x' | 'z'): 'n' | 's' | 'e' | 'w' {
  if (along === 'x') return house.roomAt(innerCx, innerCy - 1) === null ? 'n' : 's';
  return house.roomAt(innerCx - 1, innerCy) === null ? 'w' : 'e';
}

export function buildHouses(ctx: BuildContext, styleResolver: HouseStyleResolver, cfg: HouseConfig): HouseHandles {
  const { root, res, navCellSize } = ctx;
  const fadeSurfaces: FadeSurface[] = [];
  const sectionMeshes: SectionMesh[] = [];

  const ts = ctx.town;
  const grid = ts.navGrid;
  const buildings = buildingsOf(ts);
  const th = Math.min(cfg.wallPanelThickness, navCellSize); // thin shell, never wider than the cell
  const baseHeightCap = cfg.visibility.baseHeightMeters;

  // destructible section keeps its distinct tinted, hideable material (never per-house tinted).
  const sectionMat = res.mat('section', { color: 0xb04a32, roughness: 0.7 });

  // B3: bias fading upper-wall + roof faces back + lift them off the retained base so reveal faces never
  // z-fight the coplanar base top / ground (cutaway). Decisions are pure (resolveCutawayDepthOffset).
  const upperOffset = resolveCutawayDepthOffset('upperWall', cfg.cutawayDepth);
  const roofOffset = resolveCutawayDepthOffset('roof', cfg.cutawayDepth);

  // structural-section nav cells get distinct, hideable meshes; everything else is a plain wall.
  const sectionByNav = new Map<number, number>(); // navIndex -> structuralCell
  for (let z = 0; z < ts.wall.sizeZ; z++) {
    const sc = ts.wall.packCell(0, 0, z);
    const cell = ts.navCellForStructuralCell(sc);
    sectionByNav.set(grid.index(cell.cx, cell.cy), sc);
  }

  // T46: a DOOR cell is a real opening — OMIT its wall panel even when the door is currently closed (the
  // door leaf, built in buildDoorsAndWindows, fills the gap). This cuts the doorway so the leaf no longer
  // floats on a solid wall. Open door cells are already unblocked (no panel); this also covers closed ones.
  const doorNav = new Set<number>();
  for (const e of ts.exitCells) doorNav.add(grid.index(e.cx, e.cy));

  // T108: a WINDOW cell is a real SEE-THROUGH opening — the wall panel there is PUNCHED (sill + header +
  // jamb reveals) so a hole the size of the window goes clean through the full wall thickness, and the glass/
  // void built by openingsBuilder sits IN that hole. Both builders derive the window cells from the SAME
  // windowPlacements() (identical opts) so the punch and the pane align exactly (V26 — no divergence, no RNG).
  const storeyH = cfg.world.buildingWallHeightMeters;
  const winH = windowOpeningHeightMeters(storeyH);
  const winSpan = windowOpeningSpanMeters(navCellSize);
  interface WindowCell {
    readonly ns: boolean; // wall runs along X (faces ±Z) — punch the 'x' run; else punch the 'z' run
    readonly bands: ReadonlyArray<readonly [number, number]>; // [sillBottom, headerTop] openings (one per storey sill)
  }
  const winByNav = new Map<number, WindowCell>();
  for (const p of windowPlacements(ts, {
    houseVar: styleResolver.variation,
    stride: cfg.houseWindowStride,
    boardedFraction: cfg.windowBoardedFraction,
  })) {
    const bWallH = storeyH * Math.max(1, p.storeys);
    const bands = windowSillHeights(storeyH, bWallH).map((sy) => [sy, sy + winH] as const);
    winByNav.set(grid.index(p.cx, p.cy), { ns: p.ns, bands });
  }

  // The exposed edges of a blocked cell (neighbor open or out of bounds): where a real wall face lives.
  const edges = (cx: number, cy: number): { dx: number; dz: number; along: 'x' | 'z' }[] => {
    const open = (nx: number, ny: number): boolean =>
      nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height || !grid.isBlocked(grid.index(nx, ny));
    const out: { dx: number; dz: number; along: 'x' | 'z' }[] = [];
    if (open(cx, cy - 1)) out.push({ dx: 0, dz: -1, along: 'x' });
    if (open(cx, cy + 1)) out.push({ dx: 0, dz: 1, along: 'x' });
    if (open(cx + 1, cy)) out.push({ dx: 1, dz: 0, along: 'z' });
    if (open(cx - 1, cy)) out.push({ dx: -1, dz: 0, along: 'z' });
    return out;
  };

  const wallsGroup = new Group();
  root.add(wallsGroup);
  const ivyMatrices: Matrix4[] = []; // accrued across every house → ONE instanced ivy mesh (perf, V2-style)
  const debrisMatrices: Matrix4[] = [];
  const debrisColors: Color[] = [];

  buildings.forEach((bld, bi) => {
    const style = styleResolver.styleFor(bld, bi);
    const wallH = cfg.world.buildingWallHeightMeters * Math.max(1, style.storeys);
    const baseH = Math.min(baseHeightCap, wallH);
    const upperH = Math.max(0, wallH - baseH);

    const b = bld.bounds;
    const centerX = ((b.minCx + b.maxCx + 1) / 2) * navCellSize;
    const centerZ = ((b.minCy + b.maxCy + 1) / 2) * navCellSize;
    // A TEMPLATED thin-wall house (placedHouses) builds its exterior walls from the perimeter EDGES (below) —
    // the footprint cells are walkable rooms, NOT a blocked ring. A LEGACY block (cityBlock / §G) has no placed
    // house and keeps the blocked-perimeter-cell ring path.
    const house = ts.placedHouses?.[bi];

    // per-house clapboard tint (weathered); each building owns its base + per-direction upper + roof
    // materials so the cutaway fades ONLY this house and neighbours keep their colour (per-building, V59).
    // Lap-siding via the MATERIAL (single solid mesh, no separate cladding geo): a node material whose colorNode
    // is the per-house tint with a horizontal shadow groove per board (V4 spacing/groove from config).
    const baseMat = res.nodeMat(`wallBase.${bi}`, new MeshStandardNodeMaterial({ roughness: 0.92 }));
    baseMat.colorNode = claddingColorNode(style.wallColor, cfg.clapboardSpacing, cfg.clapboardGrooveDarken, cfg.clapboardGrooveWidthRatio);
    const baseParts: BoxGeometry[] = [];
    // T82/V58 DIRECTIONAL cutaway: bucket non-section upper walls by their cardinal OUTWARD normal so each
    // side fades INDEPENDENTLY — only the side(s) turned toward the camera fade. One merged mesh + one
    // transparent material per (building, direction).
    const upperByDir = new Map<string, { boxes: BoxGeometry[]; normal: VecXZ }>();
    const upperDir = (normal: VecXZ): { boxes: BoxGeometry[]; normal: VecXZ } => {
      const key = `${normal.x},${normal.z}`;
      let g = upperByDir.get(key);
      if (!g) {
        g = { boxes: [], normal };
        upperByDir.set(key, g);
      }
      return g;
    };

    if (!house) for (let cy = b.minCy; cy <= b.maxCy; cy++) {
      for (let cx = b.minCx; cx <= b.maxCx; cx++) {
        const idx = grid.index(cx, cy);
        if (!grid.isBlocked(idx)) continue;
        if (doorNav.has(idx)) continue; // T46: leave the doorway open — the door leaf fills it
        const wx = (cx + 0.5) * navCellSize;
        const wz = (cy + 0.5) * navCellSize;
        const sc = sectionByNav.get(idx);
        const faces = edges(cx, cy);
        // T70/B12: emit ONE panel per RUN orientation, CENTRED on the cell (X-run when a N/S face is exposed,
        // Z-run when an E/W face is exposed; a corner cell gets both → an L). No doubled wall, no gap.
        const orientations: ('x' | 'z')[] = [];
        if (faces.some((f) => f.along === 'x')) orientations.push('x');
        if (faces.some((f) => f.along === 'z')) orientations.push('z');
        if (orientations.length === 0) orientations.push('x');
        const sectionObjs: Object3D[] = [];
        const win = winByNav.get(idx);
        let segIdx = 0; // unique geo key per emitted sub-panel (section path caches geometry by key)

        // Emit ONE wall sub-panel of run length `runLen` (centred on the cell, shifted by `runOff` along the
        // run) spanning vertical [yB, yT]. Clips into the base band [0, baseH] (opaque, retained) and the upper
        // band [baseH, wallH] (rendered shifted up by the cutaway vertical inset; fades per-side). Section cells
        // route to individual hideable meshes; plain walls accrue into the merged base + directional upper batch.
        // Called once with the full [0, wallH] panel for a solid cell, or as sill/header/reveal pieces around a
        // punched window — the base/upper split is identical either way (a window may straddle baseHeightCap).
        const emitWallBox = (along: 'x' | 'z', runOff: number, runLen: number, yB: number, yT: number): void => {
          if (yT - yB <= 1e-4 || runLen <= 1e-4) return;
          const px = along === 'x' ? wx + runOff : wx;
          const pz = along === 'x' ? wz : wz + runOff;
          const mkGeo = (h: number): BoxGeometry =>
            along === 'x' ? new BoxGeometry(runLen, h, th) : new BoxGeometry(th, h, runLen);
          // base portion: [yB, yT] ∩ [0, baseH]
          const bTop = Math.min(yT, baseH);
          if (yB < bTop) {
            const h = bTop - yB;
            const cyB = (yB + bTop) / 2;
            if (sc !== undefined) {
              const m = new Mesh(res.geo(`section.base.${bi}.${cx}.${cy}.${along}.${segIdx}`, mkGeo(h)), sectionMat);
              m.position.set(px, cyB, pz);
              m.castShadow = true;
              m.receiveShadow = true;
              tagInteractable(m, idx); // T113/V79: the destructible §G wall section is an interactable — tag by nav cell so the silhouette GLOW hugs its meshes
              wallsGroup.add(m);
              sectionObjs.push(m);
            } else {
              const box = mkGeo(h);
              box.translate(px, cyB, pz);
              baseParts.push(box);
            }
          }
          // upper portion: [yB, yT] ∩ [baseH, wallH], shifted up by the cutaway vertical inset (V58 reveal lift)
          if (upperH > 0) {
            const uB = Math.max(yB, baseH);
            const uT = Math.min(yT, wallH);
            if (uB < uT) {
              const h = uT - uB;
              const cyU = (uB + uT) / 2 + upperOffset.verticalInsetMeters;
              if (sc !== undefined) {
                const m = new Mesh(res.geo(`section.upper.${bi}.${cx}.${cy}.${along}.${segIdx}`, mkGeo(h)), sectionMat);
                m.position.set(px, cyU, pz);
                m.castShadow = true;
                tagInteractable(m, idx); // T113/V79: section nav-cell tag for the silhouette GLOW (matches the base-portion tag)
                wallsGroup.add(m);
                sectionObjs.push(m);
              } else {
                const box = mkGeo(h);
                box.translate(px, cyU, pz);
                upperDir(upperWallOutwardNormal(along, faces, wx, wz, centerX, centerZ)).boxes.push(box);
              }
            }
          }
          segIdx++;
        };

        for (const along of orientations) {
          // T108: punch the window only in the run that carries this cell's facade (ns → X-run, else Z-run).
          const punch = win !== undefined && ((win.ns && along === 'x') || (!win.ns && along === 'z'));
          if (!punch) {
            emitWallBox(along, 0, navCellSize, 0, wallH); // solid full-height panel (unchanged)
            continue;
          }
          // jamb reveals beside the narrower-than-cell opening (full height), then the centre column with a real
          // hole at each window band — sill below + header above (+ wall between a two-storey pair).
          const openHalf = winSpan / 2;
          const revealW = (navCellSize - winSpan) / 2;
          if (revealW > 1e-4) {
            emitWallBox(along, -(openHalf + revealW / 2), revealW, 0, wallH);
            emitWallBox(along, openHalf + revealW / 2, revealW, 0, wallH);
          }
          let yCursor = 0;
          for (const [yb, yt] of [...win.bands].sort((a, b) => a[0] - b[0])) {
            const holeBottom = Math.max(0, Math.min(yb, wallH));
            if (holeBottom > yCursor) emitWallBox(along, 0, winSpan, yCursor, holeBottom);
            yCursor = Math.max(yCursor, Math.min(yt, wallH));
          }
          if (yCursor < wallH) emitWallBox(along, 0, winSpan, yCursor, wallH);
        }
        if (sc !== undefined) sectionMeshes.push({ cell: sc, objects: sectionObjs });
      }
    }

    // Templated thin-wall house: exterior walls as THIN per-edge panels (base opaque → baseParts, upper → its own
    // fade surface), mirroring the interior-partition per-edge build. Pushed BEFORE the roof/interior so the
    // per-building fade-surface order stays [exterior edges…] → [roof] → [interior edges…].
    if (house) buildExteriorEdgeWalls(bi, house, style, wallH, baseH, upperH, baseParts);

    // one merged base-wall mesh for the whole house (section cells excluded — they stay individual).
    const baseGeoMerged = res.mergeBoxes(`wallBase.geo.${bi}`, baseParts);
    if (baseGeoMerged) {
      const baseWall = new Mesh(baseGeoMerged, baseMat);
      baseWall.castShadow = true;
      baseWall.receiveShadow = true;
      wallsGroup.add(baseWall);
    }
    // one merged upper-wall mesh per direction → the per-side, per-building cutaway fade surface (V58/V59).
    if (upperH > 0) {
      for (const [key, g] of upperByDir) {
        const upperGeoMerged = res.mergeBoxes(`wallUpper.geo.${bi}.${key}`, g.boxes);
        if (!upperGeoMerged) continue;
        // Same lap-siding cladding as the base wall so siding stays CONTINUOUS across the cutaway split; the
        // material MUST remain transparent-capable (opacity driven per-frame by the cutaway) — only the class +
        // colorNode change, the transparent/opacity/polygonOffset/renderOrder + FadeSurface push order are intact.
        const upperMat = res.nodeMat(`wallUpper.${bi}.${key}`, new MeshStandardNodeMaterial({ roughness: 0.92, transparent: true, opacity: 1 }));
        upperMat.colorNode = claddingColorNode(style.wallColor, cfg.clapboardSpacing, cfg.clapboardGrooveDarken, cfg.clapboardGrooveWidthRatio);
        upperMat.polygonOffset = upperOffset.polygonOffset;
        upperMat.polygonOffsetFactor = upperOffset.polygonOffsetFactor;
        upperMat.polygonOffsetUnits = upperOffset.polygonOffsetUnits;
        const upperWall = new Mesh(upperGeoMerged, upperMat);
        upperWall.castShadow = true;
        upperWall.renderOrder = upperOffset.renderOrder;
        root.add(upperWall);
        // World-XZ centre of this side's merged upper wall (its geometry is already in world coords) — the
        // OUTSIDE-WALL cutaway projects player + camera onto the wall plane through this point (V62).
        upperGeoMerged.computeBoundingBox();
        const bb = upperGeoMerged.boundingBox;
        const sideCenterX = bb ? (bb.min.x + bb.max.x) / 2 : 0;
        const sideCenterZ = bb ? (bb.min.z + bb.max.z) / 2 : 0;
        // XZ half-extents of this side's merged shell → the X-RAY BUBBLE measures its radius to the wall's NEAREST
        // point (V74), so a long wall fades when the player nears either end, not only when near its centre.
        const sideHalfX = bb ? (bb.max.x - bb.min.x) / 2 : 0;
        const sideHalfZ = bb ? (bb.max.z - bb.min.z) / 2 : 0;
        fadeSurfaces.push({ object: upperWall, material: upperMat, kind: 'upperWall', outwardNormal: g.normal, heightMeters: wallH, buildingIndex: bi, centerX: sideCenterX, centerZ: sideCenterZ, halfX: sideHalfX, halfZ: sideHalfZ, opacity: 1 });
      }
    }

    buildRoofAssembly(b, bi, wallH, style, roofOffset);
    // interior partitions push AFTER this building's exterior upper-wall sides + roof, so the per-building
    // fade-surface order stays deterministic: [upper-wall sides…] → [roof] → [interior partition edges…].
    buildInteriorWalls(bi, style, wallH);
    buildPorch(b, bi, style, house);
    collectIvy(b, style, grid, ivyMatrices, house);
    collectDebris(b, style, debrisMatrices, debrisColors);
  });

  buildIvy(ivyMatrices);
  buildDebris(debrisMatrices, debrisColors);

  return { fadeSurfaces, sectionMeshes };

  /**
   * Item1d — EXTERIOR WALLS of a templated thin-wall house, built from the perimeter EDGES (PlacedHouse.wallEdges,
   * kind 'exterior') as THIN per-edge panels — the analogue of the interior-partition build, but keeping the
   * exterior base/upper cutaway split: the BASE band [0,baseH] is opaque and accrues into the building's merged
   * base wall (`baseParts`); the UPPER band [baseH,wallH] is its OWN transparent fade surface per edge (the cladding
   * node-material + the FadeSurface push with halfX/halfZ + the real outward normal, so the directional x-ray fades
   * only the side(s) between camera + player). The FRONT-door edge is left OPEN (openingsBuilder fills the doorway
   * + header). A WINDOW edge is PUNCHED (jamb reveals + sill + header) so the glass/void built by openingsBuilder
   * shows through the full wall depth. Pushed BEFORE the roof + interior so the per-building fade order is
   * [exterior edges…] → [roof] → [interior edges…]. Legacy cityBlock keeps the blocked-ring path (this is skipped).
   */
  function buildExteriorEdgeWalls(
    bi: number,
    house: PlacedHouse,
    style: HouseStyle,
    wallH: number,
    baseH: number,
    upperH: number,
    baseParts: BoxGeometry[],
  ): void {
    const cs = navCellSize;
    const th = Math.min(cfg.wallPanelThickness, cs);
    const storeyH = cfg.world.buildingWallHeightMeters;
    const winH = windowOpeningHeightMeters(storeyH);
    const winSpan = windowOpeningSpanMeters(cs);
    const bands = windowSillHeights(storeyH, wallH).map((sy) => [sy, sy + winH] as const);
    // the FRONT door's edge is a doorway gap (openingsBuilder builds the frame/leaf/header fill there).
    const doorGapKeys = new Set<string>();
    for (const dr of house.doors) if (dr.front) doorGapKeys.add(dr.edge.key);
    // window edges → punched (the window glass sits in the hole, openingsBuilder).
    const winEdgeKeys = new Set<string>();
    for (const w of house.windows) winEdgeKeys.add(w.edge.key);

    let edgeIdx = 0;
    for (const edge of house.wallEdges) {
      if (edge.kind !== 'exterior') continue; // interior partitions are built separately
      if (doorGapKeys.has(edge.key)) continue; // doorway gap
      // Authoritative outward face from placeHouse's scan — NEVER re-derive (the old roomAt re-derivation
      // mis-placed some walls: a face landed one cell inward / a room edge ended up outside the wall).
      const dir = edge.outwardDir ?? exteriorEdgeDir(house, edge.innerCx, edge.innerCy, edge.along);
      const dl = EXT_DIR_DELTA[dir];
      // world face centre = midpoint of the inner room cell + the outer street cell.
      const faceX = ((edge.innerCx + (edge.innerCx + dl.dx) + 1) / 2) * cs;
      const faceZ = ((edge.innerCy + (edge.innerCy + dl.dy) + 1) / 2) * cs;
      const alongX = edge.along === 'x'; // N/S face → the wall RUN is along X
      const outwardNormal: VecXZ = { x: dl.dx, z: dl.dy };
      const hasWindow = winEdgeKeys.has(edge.key);

      const upperBoxes: BoxGeometry[] = [];
      // one sub-panel of run length `len` (shifted `runOff` along the run), vertical [yB,yT]; base→opaque merged,
      // upper→this edge's transparent fade-surface batch — the exterior base/upper split, per edge.
      const emit = (runOff: number, len: number, yB: number, yT: number): void => {
        if (yT - yB <= 1e-4 || len <= 1e-4) return;
        const px = alongX ? faceX + runOff : faceX;
        const pz = alongX ? faceZ : faceZ + runOff;
        const mkGeo = (h: number): BoxGeometry => (alongX ? new BoxGeometry(len, h, th) : new BoxGeometry(th, h, len));
        const bTop = Math.min(yT, baseH);
        if (yB < bTop) {
          const box = mkGeo(bTop - yB);
          box.translate(px, (yB + bTop) / 2, pz);
          baseParts.push(box);
        }
        if (upperH > 0) {
          const uB = Math.max(yB, baseH);
          const uT = Math.min(yT, wallH);
          if (uB < uT) {
            const box = mkGeo(uT - uB);
            box.translate(px, (uB + uT) / 2 + upperOffset.verticalInsetMeters, pz);
            upperBoxes.push(box);
          }
        }
      };

      if (!hasWindow) {
        emit(0, cs, 0, wallH); // solid full-height edge panel
      } else {
        const openHalf = winSpan / 2;
        const revealW = (cs - winSpan) / 2;
        if (revealW > 1e-4) {
          emit(-(openHalf + revealW / 2), revealW, 0, wallH);
          emit(openHalf + revealW / 2, revealW, 0, wallH);
        }
        let yCursor = 0;
        for (const [yb, yt] of [...bands].sort((a, b) => a[0] - b[0])) {
          const holeBottom = Math.max(0, Math.min(yb, wallH));
          if (holeBottom > yCursor) emit(0, winSpan, yCursor, holeBottom);
          yCursor = Math.max(yCursor, Math.min(yt, wallH));
        }
        if (yCursor < wallH) emit(0, winSpan, yCursor, wallH);
      }

      // one merged transparent UPPER mesh per edge → its own per-edge x-ray fade surface (mirrors the interior
      // partitions); the cladding stays continuous with the opaque base via the same colorNode.
      const merged = res.mergeBoxes(`wallExtUpper.geo.${bi}.${edgeIdx}`, upperBoxes);
      if (merged) {
        const mat = res.nodeMat(`wallExtUpper.${bi}.${edgeIdx}`, new MeshStandardNodeMaterial({ roughness: 0.92, transparent: true, opacity: 1 }));
        mat.colorNode = claddingColorNode(style.wallColor, cfg.clapboardSpacing, cfg.clapboardGrooveDarken, cfg.clapboardGrooveWidthRatio);
        mat.polygonOffset = upperOffset.polygonOffset;
        mat.polygonOffsetFactor = upperOffset.polygonOffsetFactor;
        mat.polygonOffsetUnits = upperOffset.polygonOffsetUnits;
        const mesh = new Mesh(merged, mat);
        mesh.castShadow = true;
        mesh.renderOrder = upperOffset.renderOrder;
        root.add(mesh);
        merged.computeBoundingBox();
        const bb = merged.boundingBox;
        const sCenterX = bb ? (bb.min.x + bb.max.x) / 2 : faceX;
        const sCenterZ = bb ? (bb.min.z + bb.max.z) / 2 : faceZ;
        const halfX = bb ? (bb.max.x - bb.min.x) / 2 : 0;
        const halfZ = bb ? (bb.max.z - bb.min.z) / 2 : 0;
        fadeSurfaces.push({ object: mesh, material: mat, kind: 'upperWall', outwardNormal, heightMeters: wallH, buildingIndex: bi, centerX: sCenterX, centerZ: sCenterZ, halfX, halfZ, opacity: 1 });
      }
      edgeIdx++;
    }
  }

  /**
   * P0c — INTERIOR PARTITION WALLS from the placed floor-plan (PlacedHouse.wallEdges). The exterior walls + doors
   * + windows render from the perimeter EDGES (buildExteriorEdgeWalls, thin-wall model); this adds the room
   * dividers so the cutaway reveals a MULTI-ROOM interior instead of one open box. Each interior wallEdge is a
   * solid full-height panel centred on the shared cell face; an edge a DOOR opens is omitted (the doorway gap).
   * Districts without templates (cityBlock) skip this.
   *
   * ITEM D — each partition is its OWN fade surface (kind 'upperWall') so the X-RAY BUBBLE (V74) fades ONLY the
   * partition(s) genuinely BETWEEN the player and the camera, leaving the rest solid (the rooms still read) — the
   * fix for "the player vanishes behind an interior wall indoors". PER-EDGE granularity is required on BOTH the
   * geometry (its own AABB for the segment-vs-box occlusion test) AND the material (Three opacity is per-material,
   * so a shared material would fade every partition at once → no granularity); hence one transparent mesh + one
   * transparent material per edge, mirroring the exterior upper-wall fade-surface push. The CutawaySystem drives
   * opacity/depthWrite/visible uniformly over every fade surface, so partitions inherit V20/V60/V65/V29 for free.
   */
  function buildInteriorWalls(bi: number, style: HouseStyle, wallH: number): void {
    const house = ts.placedHouses?.[bi];
    if (!house) return;
    const cs = navCellSize;
    // doorway gaps: the interior edges a door opens are left out (open passage between rooms).
    const doorEdgeKeys = new Set<string>();
    for (const door of house.doors) if (!door.exterior) doorEdgeKeys.add(door.edge.key);
    // plaster-ish interior divider tint, derived from the house tint so it sits with the building (V59).
    const tint = interiorWallColor(style.wallColor);
    let edgeIdx = 0; // deterministic per-edge key (geometry/material) in house.wallEdges order
    for (const edge of house.wallEdges) {
      if (edge.kind !== 'interior') continue; // exterior shell already rendered from the ring
      if (doorEdgeKeys.has(edge.key)) continue; // doorway gap
      if (edge.outerCx === null || edge.outerCy === null) continue;
      // world centre of the shared face = midpoint of the two adjacent cell centres (the fade-surface AABB centre).
      const cxw = ((edge.innerCx + edge.outerCx + 1) / 2) * cs;
      const czw = ((edge.innerCy + edge.outerCy + 1) / 2) * cs;
      // 'z' run (cells differ in cx) → thin in X, full span in Z; 'x' run → thin in Z, full span in X.
      const alongZ = edge.along === 'z';
      const geo = res.geo(`wallInterior.geo.${bi}.${edgeIdx}`, alongZ ? new BoxGeometry(th, wallH, cs) : new BoxGeometry(cs, wallH, th));
      // transparent-capable per-edge material (opacity driven per-frame by the cutaway), one mesh per edge.
      const mat = res.mat(`wallInterior.${bi}.${edgeIdx}`, { color: tint, roughness: 0.95, transparent: true, opacity: 1 });
      const mesh = new Mesh(geo, mat);
      mesh.position.set(cxw, wallH / 2, czw);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      wallsGroup.add(mesh);
      // Per-edge X-RAY fade surface. kind 'upperWall' → the cutaway treats it as a WALL (segment-vs-AABB), NOT a
      // roof. outwardNormal MUST be NON-NULL: surfaceInXrayField reads a null normal as a ROOF (always occludes
      // within radius), which would fade EVERY nearby partition; the wall test is normal-FREE, so the value is
      // irrelevant — only its presence selects the segment-vs-box test. AABB = the edge footprint: thin on the
      // run-normal axis (th/2), full cell span on the run axis (cs/2).
      const halfX = alongZ ? th / 2 : cs / 2;
      const halfZ = alongZ ? cs / 2 : th / 2;
      const outwardNormal: VecXZ = alongZ ? { x: 1, z: 0 } : { x: 0, z: 1 };
      fadeSurfaces.push({ object: mesh, material: mat, kind: 'upperWall', outwardNormal, heightMeters: wallH, buildingIndex: bi, centerX: cxw, centerZ: czw, halfX, halfZ, opacity: 1 });
      edgeIdx++;
    }
  }

  /** Shaped roof (gable / hip / flat) + chimney + decay holes, grouped so the whole assembly is the building's
   *  cutaway fade surface (V20). A collapsed house sags its roof. */
  function buildRoofAssembly(
    b: CellRect,
    bi: number,
    wallH: number,
    style: HouseStyle,
    roofOff: ReturnType<typeof resolveCutawayDepthOffset>,
  ): void {
    const cs = navCellSize;
    const rw = (b.maxCx - b.minCx + 1) * cs;
    const rd = (b.maxCy - b.minCy + 1) * cs;
    const cxw = ((b.minCx + b.maxCx + 1) / 2) * cs;
    const czw = ((b.minCy + b.maxCy + 1) / 2) * cs;

    // procedural asphalt-shingle node material (polish #6): a node material so the colorNode bands the tint into
    // shingle courses/tabs. Stays transparent-capable (opacity driven per-frame by the cutaway) + DoubleSide.
    const roofMat = res.nodeMat(`roof.${bi}`, new MeshStandardNodeMaterial({ roughness: 0.95, transparent: true, opacity: 1, side: DoubleSide }));
    roofMat.colorNode = roofShingleColorNode(style.roofColor);
    roofMat.polygonOffset = roofOff.polygonOffset;
    roofMat.polygonOffsetFactor = roofOff.polygonOffsetFactor;
    roofMat.polygonOffsetUnits = roofOff.polygonOffsetUnits;

    const group = new Group();
    const roofGeo = res.geo(`roof.geo.${bi}`, makeRoofGeometry(style.roofShape, rw, rd, style.roofPitchMeters, cfg.roofOverhang, style.ridgeAlongX));
    const roof = new Mesh(roofGeo, roofMat);
    roof.renderOrder = roofOff.renderOrder;
    roof.castShadow = true;
    group.add(roof);

    // Materials of the roof-group EXTRAS (chimney + decay holes). They use their OWN materials, NOT roofMat, so
    // the cutaway — which fades ONE material per fade surface — would leave them OPAQUE while the roof x-rays
    // away (a chimney + dark hole-boxes left floating where the roof was: the "weird stuff on the roof" bug).
    // Collected here and pushed as their own 'roof' fade surfaces (same footprint AABB) so they dissolve WITH it.
    const roofExtraMats: { mat: Parameters<typeof fadeSurfaces.push>[0]['material'] }[] = [];

    // roof decay — caved-in / missing-shingle patches near the ridge (dark voids reading as holes).
    const holes = roofHoles(style, styleResolver.variation.roofHoleDamageThreshold, styleResolver.variation.roofHoleMaxCount);
    if (holes.length > 0) {
      const holeMat = res.mat(`roofHole.${bi}`, { color: 0x0d0c0a, roughness: 1, side: DoubleSide });
      roofExtraMats.push({ mat: holeMat });
      const ridgeLen = style.roofShape === 'gable' ? (style.ridgeAlongX ? rw : rd) : Math.max(rw, rd);
      const ridgeAlongX = style.roofShape === 'gable' ? style.ridgeAlongX : rw >= rd;
      for (let h = 0; h < holes.length; h++) {
        const hole = holes[h]!;
        const along = (hole.t - 0.5) * ridgeLen;
        const size = Math.min(hole.radiusMeters * 2, Math.min(rw, rd) * 0.8);
        const box = new Mesh(res.geo(`roofHole.geo.${bi}.${h}`, new BoxGeometry(size, 0.14, size)), holeMat);
        const y = Math.max(0.2, style.roofPitchMeters - 0.25);
        box.position.set(ridgeAlongX ? along : 0, y, ridgeAlongX ? 0 : along);
        group.add(box);
      }
    }

    if (style.hasChimney) {
      const c = cfg.chimneyMeters;
      const chimneyH = style.roofPitchMeters + cfg.world.buildingWallHeightMeters * 0.5;
      const chimneyMat = res.mat(`chimney.${bi}`, { color: 0x6e4a3a, roughness: 0.95 });
      roofExtraMats.push({ mat: chimneyMat });
      const chimney = new Mesh(res.geo(`chimney.geo.${bi}`, new BoxGeometry(c, chimneyH, c)), chimneyMat);
      const sx = (hash01(style.seed, 71) - 0.5) * (rw - c - 0.6);
      const sz = (hash01(style.seed, 72) - 0.5) * (rd - c - 0.6);
      chimney.position.set(sx, chimneyH / 2, sz);
      chimney.castShadow = true;
      group.add(chimney);
    }

    group.position.set(cxw, wallH, czw);
    if (style.collapsed) {
      // sag about Z by a fixed gentle tilt, then LIFT the group by the low eave's vertical drop so the lowest
      // eave stays ON the wall plate (never below it → walls never poke through above the roof, polish #8).
      const sag = (hash01(style.seed, 80) < 0.5 ? 1 : -1) * COLLAPSED_ROOF_SAG_RADIANS;
      group.rotation.z = sag;
      const hx = rw / 2 + cfg.roofOverhang; // roof half-extent along the tilt (X) axis, incl. eave overhang
      group.position.y += hx * Math.sin(Math.abs(sag)); // raise so the dipped eave returns to the wall top
    }
    root.add(group);
    // Half-extents = the roof footprint half-dimensions, so the X-RAY BUBBLE (V74) measures its radius to the
    // footprint's NEAREST point: a player anywhere INSIDE the footprint has distance 0 and so always reveals its
    // roof (preserves V20 "see the room you stand in"), regardless of the bubble radius or footprint size.
    fadeSurfaces.push({ object: group, material: roofMat, kind: 'roof', outwardNormal: null, heightMeters: wallH, buildingIndex: bi, centerX: cxw, centerZ: czw, halfX: rw / 2, halfZ: rd / 2, opacity: 1 });
    // Chimney + decay-hole materials fade WITH the roof (same footprint AABB + 'roof' kind) so nothing is left
    // floating opaque when the roof x-rays away. `object: group` keeps them in the SAME group the cutaway hides.
    for (const extra of roofExtraMats) {
      fadeSurfaces.push({ object: group, material: extra.mat, kind: 'roof', outwardNormal: null, heightMeters: wallH, buildingIndex: bi, centerX: cxw, centerZ: czw, halfX: rw / 2, halfZ: rd / 2, opacity: 1 });
    }
  }

  /** A covered front entry porch CENTRED on the house's street door, projecting outward along the door's own
   *  outward normal (templated houses carry the door cell + direction; legacy houses fall back to the south
   *  exit cell). Deck + posts + a low shed roof. Always visible (it sits outside the footprint, so it is not a
   *  cutaway occluder). The deck rests just ABOVE the grass paint plane so it never z-fights the lawn. */
  function buildPorch(b: CellRect, bi: number, style: HouseStyle, house: PlacedHouse | undefined): void {
    if (!style.hasPorch) return;
    const cs = navCellSize;
    // Door cell + outward direction. Templated: the front door (doors[0]) is the first exterior door and carries
    // its outward edge. Legacy: the exit cell on the south perimeter (the only side the old block opened).
    let doorCx: number;
    let doorCy: number;
    let nx: number;
    let nz: number;
    const front = house?.doors[0];
    if (front) {
      doorCx = front.cx;
      doorCy = front.cy;
      nx = front.dir === 'e' ? 1 : front.dir === 'w' ? -1 : 0;
      nz = front.dir === 's' ? 1 : front.dir === 'n' ? -1 : 0;
    } else {
      const exit = ts.exitCells.find((e) => e.cx >= b.minCx && e.cx <= b.maxCx && e.cy >= b.minCy && e.cy <= b.maxCy);
      if (!exit) return;
      doorCx = exit.cx;
      doorCy = exit.cy;
      nx = 0;
      nz = 1; // legacy block doors face south
    }
    const depth = Math.min(cfg.world.housePorchDepthMeters, cs * 1.2); // porch run out from the wall
    const width = cs * 2.2; // span ALONG the wall (perpendicular to the outward normal)
    // Deck centre: door-cell centre, pushed out by half a cell (to the wall face) + half the porch depth.
    const cellCx = (doorCx + 0.5) * cs;
    const cellCz = (doorCy + 0.5) * cs;
    const outDist = cs / 2 + depth / 2;
    const px = cellCx + nx * outDist;
    const pz = cellCz + nz * outDist;
    // BoxGeometry footprint: `width` runs along the wall, `depth` runs along the normal. Swap X/Z for e/w doors.
    const alongX = nz !== 0; // n/s door → wall runs along X; e/w door → wall runs along Z
    const footW = alongX ? width : depth;
    const footD = alongX ? depth : width;
    const mat = res.mat(`porch.${bi}`, { color: style.trimColor, roughness: 0.9 });
    const group = new Group();
    // deck — a thin slab resting just above the grass paint (y=0.08) so it never z-fights the lawn or base ground.
    const DECK_THICK = 0.14;
    const DECK_Y = 0.17; // bottom = 0.10 > grass plane (0.08); top = 0.24
    const deck = new Mesh(res.geo(`porch.deck.${bi}`, new BoxGeometry(footW, DECK_THICK, footD)), mat);
    deck.position.set(px, DECK_Y, pz);
    deck.receiveShadow = true;
    group.add(deck);
    // roof
    const roofY = cfg.porchHeightMeters;
    const proof = new Mesh(res.geo(`porch.roof.${bi}`, new BoxGeometry(footW + 0.3, 0.12, footD + 0.2)), mat);
    proof.position.set(px, roofY, pz);
    proof.castShadow = true;
    group.add(proof);
    // posts at the two outer corners (far edge of the porch, at each end of the wall-span axis)
    const postGeo = res.geo(`porch.post.${bi}`, new BoxGeometry(0.14, roofY, 0.14));
    const farX = px + nx * (depth / 2 - 0.15); // outer (away-from-house) edge
    const farZ = pz + nz * (depth / 2 - 0.15);
    for (const off of [-width / 2 + 0.1, width / 2 - 0.1]) {
      const post = new Mesh(postGeo, mat);
      // offset runs along the wall-span axis (X for n/s doors, Z for e/w doors)
      post.position.set(farX + (alongX ? off : 0), roofY / 2, farZ + (alongX ? 0 : off));
      post.castShadow = true;
      group.add(post);
    }
    root.add(group);
  }

  /** Accrue per-house ivy/overgrowth instances climbing the EXTERIOR wall faces, scaled by style.ivy. The
   *  caller flushes one shared instanced mesh for the whole district. */
  function collectIvy(b: CellRect, style: HouseStyle, navGrid: NavGrid, out: Matrix4[], house: PlacedHouse | undefined): void {
    if (style.ivy <= 0) return;
    const cs = navCellSize;
    const wallH = cfg.world.buildingWallHeightMeters * Math.max(1, style.storeys);
    const reach = style.ivy * wallH;
    const patches = Math.max(1, Math.round(reach / cfg.ivyPatchMeters));
    const templated = house !== undefined;
    // Don't grow plants in front of a WINDOW or DOOR opening — they belong on solid wall, set a bit out into the
    // yard (not merged into the wall plane). Skip the opening cells.
    const openingCells = new Set<number>();
    if (house) {
      for (const w of house.windows) openingCells.add(navGrid.index(w.cx, w.cy));
      for (const dr of house.doors) openingCells.add(navGrid.index(dr.cx, dr.cy));
    }
    const q = new Quaternion();
    const s = new Vector3(1, 1, 1);
    const pos = new Vector3();
    for (let cy = b.minCy; cy <= b.maxCy; cy++) {
      for (let cx = b.minCx; cx <= b.maxCx; cx++) {
        if (cx !== b.minCx && cx !== b.maxCx && cy !== b.minCy && cy !== b.maxCy) continue; // perimeter only
        const idx = navGrid.index(cx, cy);
        // Legacy block: an exterior wall is a BLOCKED perimeter cell. Thin-wall house: the perimeter cells ARE
        // walkable rooms (no blocked ring) — every perimeter cell carries an exterior edge-wall face, so ivy
        // climbs them all.
        if (!templated && !navGrid.isBlocked(idx)) continue;
        if (openingCells.has(idx)) continue; // not in front of a window/door
        const cellRoll = hash01(style.seed, 5100 + cx * 31 + cy * 7);
        if (cellRoll > style.ivy) continue; // denser ivy on more overgrown houses
        // outward face normal: pick the first open neighbour direction.
        let nx = 0;
        let nz = 0;
        if (cx === b.minCx) nx = -1;
        else if (cx === b.maxCx) nx = 1;
        else if (cy === b.minCy) nz = -1;
        else nz = 1;
        const wx = (cx + 0.5) * cs + nx * (cs / 2);
        const wz = (cy + 0.5) * cs + nz * (cs / 2);
        for (let p = 0; p < patches; p++) {
          if (out.length >= cfg.ivyInstanceCap) {
            console.warn(`[BlockScene] ivy instance cap (${cfg.ivyInstanceCap}) hit — capping district overgrowth`);
            return;
          }
          const y = (p + 0.5) * cfg.ivyPatchMeters * 0.85;
          // sit the plant a bit OUT into the yard (0.4 m beyond the wall face), not merged into the wall plane.
          pos.set(wx + nx * IVY_YARD_OFFSET_METERS, y, wz + nz * IVY_YARD_OFFSET_METERS);
          out.push(new Matrix4().compose(pos, q, s));
        }
      }
    }
  }

  /** One shared instanced ivy mesh for the whole district (flattened green patches; 1 draw call). */
  function buildIvy(matrices: Matrix4[]): void {
    if (matrices.length === 0) return;
    const geo = res.geo('ivy.geo', new IcosahedronGeometry(cfg.ivyPatchMeters * 0.5, 0));
    geo.scale(1, 1, 0.4); // flattened against the wall
    const mat = res.mat('ivy', { color: 0x35501f, roughness: 1 });
    const mesh = new InstancedMesh(geo, mat, matrices.length);
    res.track(mesh, 'buffer', 'ivy.instanced');
    for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]!);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  /** Accrue base debris/rubble clumps strewn around a ruined house's perimeter, count scaled by damage. */
  function collectDebris(b: CellRect, style: HouseStyle, out: Matrix4[], colors: Color[]): void {
    const count = Math.round(style.damage * cfg.houseDebrisMaxCount);
    if (count <= 0) return;
    const cs = navCellSize;
    const minX = b.minCx * cs;
    const maxX = (b.maxCx + 1) * cs;
    const minZ = b.minCy * cs;
    const maxZ = (b.maxCy + 1) * cs;
    const _p = new Vector3();
    const _q = new Quaternion();
    const _s = new Vector3();
    const _e = new Euler();
    for (let i = 0; i < count; i++) {
      const side = Math.floor(hash01(style.seed, 6100 + i * 5) * 4);
      const along = hash01(style.seed, 6101 + i * 5);
      const out2 = 0.3 + hash01(style.seed, 6102 + i * 5) * 0.6; // distance just outside the wall
      let x: number;
      let z: number;
      if (side === 0) { x = minX + along * (maxX - minX); z = minZ - out2; }
      else if (side === 1) { x = minX + along * (maxX - minX); z = maxZ + out2; }
      else if (side === 2) { x = minX - out2; z = minZ + along * (maxZ - minZ); }
      else { x = maxX + out2; z = minZ + along * (maxZ - minZ); }
      const sc = 0.55 + hash01(style.seed, 6103 + i * 5) * 0.7;
      _q.setFromEuler(_e.set(0, hash01(style.seed, 6104 + i * 5) * Math.PI, 0));
      out.push(new Matrix4().compose(_p.set(x, cfg.debrisMeters * 0.35 * sc, z), _q, _s.set(sc, sc * 0.7, sc)));
      colors.push(new Color(0x4a463f).offsetHSL(0, 0, (hash01(style.seed, 6105 + i * 5) - 0.5) * 0.14));
    }
  }

  /** One shared instanced debris mesh for the whole district (faceted rubble lumps; 1 draw call). */
  function buildDebris(matrices: Matrix4[], colors: Color[]): void {
    if (matrices.length === 0) return;
    const geo = res.geo('debris.geo', new IcosahedronGeometry(cfg.debrisMeters * 0.6, 0));
    const mat = res.mat('debris', { color: 0xffffff, roughness: 1 });
    const mesh = new InstancedMesh(geo, mat, matrices.length);
    res.track(mesh, 'buffer', 'debris.instanced');
    for (let i = 0; i < matrices.length; i++) {
      mesh.setMatrixAt(i, matrices[i]!);
      mesh.setColorAt(i, colors[i]!);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
}
