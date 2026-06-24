// House builder: the per-building shell (T87) — perimeter base/upper walls, destructible §G section meshes,
// horizontal clapboard siding, shaped roof + chimney + decay holes, front porch, and the shared instanced ivy
// + debris dressing for the whole district. Returns HouseHandles (fade surfaces + section meshes) the cutaway
// and breach systems consume per-frame. Pure static construction. Extracted from BlockScene
// (docs/REFACTOR-godfiles.md). The fade-surface PUSH ORDER (per building: upper-wall sides → clapboard sides →
// roof) is load-bearing — blockScene.test asserts the surface indices/counts.

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
import { color, float, fract, positionWorld, smoothstep } from 'three/tsl';
import {
  buildingsOf,
  roofHoles,
  hash01,
  windowPlacements,
  type HouseStyle,
  type CellRect,
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
import { worldConfig } from '../../../config/domains/world';
import type { ResolvedDomain } from '../../../config/types';
import type { BuildContext } from './buildContext';
import type { FadeSurface, HouseHandles, SectionMesh } from './handles';
import type { HouseStyleResolver } from './houseStyle';

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

    for (let cy = b.minCy; cy <= b.maxCy; cy++) {
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

    buildInteriorWalls(bi, style, wallH);
    buildRoofAssembly(b, bi, wallH, style, roofOffset);
    buildPorch(b, bi, style);
    collectIvy(b, style, grid, ivyMatrices);
    collectDebris(b, style, debrisMatrices, debrisColors);
  });

  buildIvy(ivyMatrices);
  buildDebris(debrisMatrices, debrisColors);

  return { fadeSurfaces, sectionMeshes };

  /**
   * P0c — INTERIOR PARTITION WALLS from the placed floor-plan (PlacedHouse.wallEdges). The exterior shell +
   * doors + windows already render from the blocked perimeter ring (the placed house's exterior, 1:1); this
   * adds the room dividers so the cutaway reveals a MULTI-ROOM interior instead of one open box. Each interior
   * wallEdge is a solid full-height panel centred on the shared cell face; an edge a DOOR opens is omitted
   * (the doorway gap). Solid + opaque (NOT a fade surface) so partitions stay readable once the roof fades —
   * they are the room dividers the player should see. Districts without templates (cityBlock) skip this.
   */
  function buildInteriorWalls(bi: number, style: HouseStyle, wallH: number): void {
    const house = ts.placedHouses?.[bi];
    if (!house) return;
    const cs = navCellSize;
    // doorway gaps: the interior edges a door opens are left out (open passage between rooms).
    const doorEdgeKeys = new Set<string>();
    for (const door of house.doors) if (!door.exterior) doorEdgeKeys.add(door.edge.key);
    const boxes: BoxGeometry[] = [];
    for (const edge of house.wallEdges) {
      if (edge.kind !== 'interior') continue; // exterior shell already rendered from the ring
      if (doorEdgeKeys.has(edge.key)) continue; // doorway gap
      if (edge.outerCx === null || edge.outerCy === null) continue;
      // world centre of the shared face = midpoint of the two adjacent cell centres.
      const cxw = ((edge.innerCx + edge.outerCx + 1) / 2) * cs;
      const czw = ((edge.innerCy + edge.outerCy + 1) / 2) * cs;
      // 'z' run (cells differ in cx) → thin in X, full span in Z; 'x' run → thin in Z, full span in X.
      const box = edge.along === 'z' ? new BoxGeometry(th, wallH, cs) : new BoxGeometry(cs, wallH, th);
      box.translate(cxw, wallH / 2, czw);
      boxes.push(box);
    }
    const merged = res.mergeBoxes(`wallInterior.geo.${bi}`, boxes);
    if (!merged) return;
    // plaster-ish interior divider tint, derived from the house tint so it sits with the building (V59).
    const mat = res.mat(`wallInterior.${bi}`, { color: interiorWallColor(style.wallColor), roughness: 0.95 });
    const mesh = new Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    wallsGroup.add(mesh);
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

    const roofMat = res.mat(`roof.${bi}`, { color: style.roofColor, roughness: 0.95, transparent: true, opacity: 1, side: DoubleSide });
    roofMat.polygonOffset = roofOff.polygonOffset;
    roofMat.polygonOffsetFactor = roofOff.polygonOffsetFactor;
    roofMat.polygonOffsetUnits = roofOff.polygonOffsetUnits;

    const group = new Group();
    const roofGeo = res.geo(`roof.geo.${bi}`, makeRoofGeometry(style.roofShape, rw, rd, style.roofPitchMeters, cfg.roofOverhang, style.ridgeAlongX));
    const roof = new Mesh(roofGeo, roofMat);
    roof.renderOrder = roofOff.renderOrder;
    roof.castShadow = true;
    group.add(roof);

    // roof decay — caved-in / missing-shingle patches near the ridge (dark voids reading as holes).
    const holes = roofHoles(style, styleResolver.variation.roofHoleDamageThreshold, styleResolver.variation.roofHoleMaxCount);
    if (holes.length > 0) {
      const holeMat = res.mat(`roofHole.${bi}`, { color: 0x0d0c0a, roughness: 1, side: DoubleSide });
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
      const chimney = new Mesh(res.geo(`chimney.geo.${bi}`, new BoxGeometry(c, chimneyH, c)), res.mat(`chimney.${bi}`, { color: 0x6e4a3a, roughness: 0.95 }));
      const sx = (hash01(style.seed, 71) - 0.5) * (rw - c - 0.6);
      const sz = (hash01(style.seed, 72) - 0.5) * (rd - c - 0.6);
      chimney.position.set(sx, chimneyH / 2, sz);
      chimney.castShadow = true;
      group.add(chimney);
    }

    group.position.set(cxw, wallH, czw);
    if (style.collapsed) group.rotation.z = (hash01(style.seed, 80) < 0.5 ? 1 : -1) * 0.14; // sagging caved roof
    root.add(group);
    // Half-extents = the roof footprint half-dimensions, so the X-RAY BUBBLE (V74) measures its radius to the
    // footprint's NEAREST point: a player anywhere INSIDE the footprint has distance 0 and so always reveals its
    // roof (preserves V20 "see the room you stand in"), regardless of the bubble radius or footprint size.
    fadeSurfaces.push({ object: group, material: roofMat, kind: 'roof', outwardNormal: null, heightMeters: wallH, buildingIndex: bi, centerX: cxw, centerZ: czw, halfX: rw / 2, halfZ: rd / 2, opacity: 1 });
  }

  /** A covered front porch at the house's street door: deck + posts + a low shed roof. Always visible (it sits
   *  outside the footprint, so it is not a cutaway occluder). */
  function buildPorch(b: CellRect, bi: number, style: HouseStyle): void {
    if (!style.hasPorch) return;
    const cs = navCellSize;
    const door = ts.exitCells.find((e) => e.cx >= b.minCx && e.cx <= b.maxCx && e.cy >= b.minCy && e.cy <= b.maxCy);
    if (!door) return;
    const depth = Math.min(cfg.world.housePorchDepthMeters, cs * 1.2); // porch run out from the wall
    const width = cs * 2.2;
    const dx = (door.cx + 0.5) * cs;
    const southZ = (b.maxCy + 1) * cs; // door is on the south perimeter
    const outZ = southZ + depth / 2;
    const mat = res.mat(`porch.${bi}`, { color: style.trimColor, roughness: 0.9 });
    const group = new Group();
    // deck
    const deck = new Mesh(res.geo(`porch.deck.${bi}`, new BoxGeometry(width, 0.16, depth)), mat);
    deck.position.set(dx, 0.08, outZ);
    deck.receiveShadow = true;
    group.add(deck);
    // roof
    const roofY = cfg.porchHeightMeters;
    const proof = new Mesh(res.geo(`porch.roof.${bi}`, new BoxGeometry(width + 0.3, 0.12, depth + 0.2)), mat);
    proof.position.set(dx, roofY, outZ);
    proof.castShadow = true;
    group.add(proof);
    // posts at the outer corners
    const postGeo = res.geo(`porch.post.${bi}`, new BoxGeometry(0.14, roofY, 0.14));
    for (const ox of [-width / 2 + 0.1, width / 2 - 0.1]) {
      const post = new Mesh(postGeo, mat);
      post.position.set(dx + ox, roofY / 2, southZ + depth - 0.15);
      post.castShadow = true;
      group.add(post);
    }
    root.add(group);
  }

  /** Accrue per-house ivy/overgrowth instances climbing the EXTERIOR wall faces, scaled by style.ivy. The
   *  caller flushes one shared instanced mesh for the whole district. */
  function collectIvy(b: CellRect, style: HouseStyle, navGrid: NavGrid, out: Matrix4[]): void {
    if (style.ivy <= 0) return;
    const cs = navCellSize;
    const wallH = cfg.world.buildingWallHeightMeters * Math.max(1, style.storeys);
    const reach = style.ivy * wallH;
    const patches = Math.max(1, Math.round(reach / cfg.ivyPatchMeters));
    const q = new Quaternion();
    const s = new Vector3(1, 1, 1);
    const pos = new Vector3();
    for (let cy = b.minCy; cy <= b.maxCy; cy++) {
      for (let cx = b.minCx; cx <= b.maxCx; cx++) {
        if (cx !== b.minCx && cx !== b.maxCx && cy !== b.minCy && cy !== b.maxCy) continue; // perimeter only
        const idx = navGrid.index(cx, cy);
        if (!navGrid.isBlocked(idx)) continue;
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
          pos.set(wx + nx * 0.06, y, wz + nz * 0.06);
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
