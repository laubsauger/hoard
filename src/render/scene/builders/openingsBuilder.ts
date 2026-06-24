// Openings builder: doors + windows so each shell reads as a house (T46/T108). Additive render pass (does not
// alter the wall grid): a framed, hinged door leaf at each exit gap, and per-building windows on a deterministic
// subset of facade cells. Returns OpeningHandles (door leaves + window units) the door/window systems reflect
// sim state onto each frame (V12). Pure static construction. Extracted from BlockScene
// (docs/REFACTOR-godfiles.md).

import { BoxGeometry, Group, Mesh, type BufferGeometry, type MeshStandardMaterial } from 'three';
import { buildingsOf, doorAxis, doorAxisForDir, hash01, windowPlacements } from '../../../game/scene';
import type { WallDir } from '../../../game/navigation';
import { tagInteractable } from '../../effects/highlightView';
import type { BuildContext } from './buildContext';
import type { DoorLeaf, OpeningHandles, WindowMesh } from './handles';
import type { HouseStyleResolver } from './houseStyle';
import {
  WINDOW_GLASS_DEPTH_METERS,
  wallShellThicknessMeters,
  windowOpeningHeightMeters,
  windowOpeningSpanMeters,
  windowSillHeights,
} from './windowGeometry';

export interface OpeningConfig {
  readonly buildingWallHeightMeters: number;
  readonly houseWindowStride: number;
  /** Fraction of facade windows that start boarded over (T87/V26). */
  readonly windowBoardedFraction: number;
  readonly openingFrameThicknessMeters: number;
  readonly doorLeafThicknessMeters: number;
  readonly doorLeafHeightFraction: number;
  readonly doorLeafWidthFraction: number;
  readonly doorOpenSwingRadians: number;
  readonly maxBoardsPerWindow: number;
  /** Wall panel thickness — the depth the window opening is punched through (the thin glass pane sits centred
   *  inside it; the frame trim laps proud of both wall faces). */
  readonly wallPanelThickness: number;
}

export function buildOpenings(ctx: BuildContext, styleResolver: HouseStyleResolver, cfg: OpeningConfig): OpeningHandles {
  const { root, res } = ctx;
  const doorLeaves: DoorLeaf[] = [];
  const windowMeshes: WindowMesh[] = [];

  const ts = ctx.town;
  const grid = ts.navGrid;
  const cs = ctx.navCellSize;
  const wallH = cfg.buildingWallHeightMeters;
  const group = new Group();

  const frameMat = res.mat('opening.frame', { color: 0x2e2118, roughness: 0.8 });
  const leafMat = res.mat('door.leaf', { color: 0x5a3d24, roughness: 0.65 });
  const glassMat = res.mat('window.glass', {
    color: 0x9fc6e0,
    roughness: 0.08,
    metalness: 0,
    transparent: true,
    opacity: 0.34,
    emissive: 0x10212e,
  });
  // T87 window decay: painted frame trim, a dark void behind smashed glass, and weathered boards.
  const winFrameMat = res.mat('window.frame', { color: 0xcfc7b4, roughness: 0.85 });
  // House polish #5: distinct depths kill the coincident-face z-fight. The trim also gets polygonOffset so its
  // proud lapping faces never flicker against the wall jamb / glass even where they grow near-coplanar.
  winFrameMat.polygonOffset = true;
  winFrameMat.polygonOffsetFactor = -1;
  winFrameMat.polygonOffsetUnits = -1;
  const voidMat = res.mat('window.void', { color: 0x0c0d0e, roughness: 1 });
  const boardMat = res.mat('window.board', { color: 0x6b5640, roughness: 0.95 });
  const th = wallShellThicknessMeters(cfg.wallPanelThickness, cs); // wall depth the opening is punched through
  const winH = windowOpeningHeightMeters(cfg.buildingWallHeightMeters); // matches the houseBuilder wall punch
  const winSpan = windowOpeningSpanMeters(cs); // wide picture window — matches the houseBuilder wall punch
  // House polish #5 — a window is a THIN pane in the opening, not a full-wall-depth slab. Distinct depths per
  // element so no two coincident faces z-fight: the GLASS is a thin slab CENTRED at the opening mid-plane
  // (depth 0); the dark VOID (never shown — see windowSystem) sits a hair BEHIND it; the painted FRAME trim is
  // a hollow ring lapped PROUD of both wall faces; the BOARDS are nailed PROUDER STILL, just outside the frame
  // plane. The opening itself is still a real hole punched through the full wall depth `th`, so it stays
  // see-through (thin glass when intact, a clear hole when smashed). Thickness on local X; the caller rotates
  // for N/S walls.
  const glassDepth = WINDOW_GLASS_DEPTH_METERS; // thin centred pane
  const frameBorder = 0.06; // trim bar width (thinner, polish #5)
  const frameDepth = th + 0.03; // proud of both wall faces so the trim reads from inside + outside
  const boardDepth = frameDepth + 0.04; // boards nailed PROUD of the frame so they never share its plane
  const voidBehind = glassDepth + 0.01; // push the (hidden) void clearly behind the glass (no shared plane)
  // Inset the pane a hair INSIDE the opening so its rim faces are NOT coplanar with the frame trim's inner
  // faces (the rails/stiles lap to winH/2 + winSpan/2). The ~2 cm reveal is invisible at iso distance.
  const paneInset = 0.04;
  const paneGeo = res.geo('window.pane.geo', new BoxGeometry(glassDepth, winH - paneInset, winSpan - paneInset));
  const voidGeo = res.geo('window.void.geo', new BoxGeometry(glassDepth, winH - paneInset, winSpan - paneInset));
  const frameRailGeo = res.geo('window.frame.rail.geo', new BoxGeometry(frameDepth, frameBorder, winSpan + frameBorder * 2)); // top/bottom
  const frameStileGeo = res.geo('window.frame.stile.geo', new BoxGeometry(frameDepth, winH, frameBorder)); // left/right
  const boardGeo = res.geo('window.board.geo', new BoxGeometry(boardDepth, winH * 0.26, winSpan + 0.1));

  // ---- DOORS (T46): the wall panel at a door cell is OMITTED (buildHouses) so a real doorway GAP exists.
  // Here we frame it (posts + lintel), fill the wall ABOVE the header back up to the building height (so a tall
  // storey leaves no hole over the door), and hang a flat LEAF off a hinge pivot. Closed, the leaf lies in the
  // wall plane and fills the opening; open, syncDoors swings the pivot ~90°. Orientation follows the wall run
  // (doorAxis): a leaf in an X-running wall spans X and faces ±Z, and vice-versa. ----
  const frameTh = cfg.openingFrameThicknessMeters;
  const leafTh = cfg.doorLeafThicknessMeters;
  const leafHeight = wallH * cfg.doorLeafHeightFraction;
  const buildingsForDoors = buildingsOf(ts);
  const DOOR_DIR_DELTA: Record<WallDir, { dx: number; dy: number }> = {
    n: { dx: 0, dy: -1 },
    s: { dx: 0, dy: 1 },
    e: { dx: 1, dy: 0 },
    w: { dx: -1, dy: 0 },
  };
  // T135: build leaves for the building EXIT doors AND the interactive INTERIOR doors (same edge-door geometry —
  // the per-cell geo keys stay unique, and an interior cell still resolves its building for wall height + tint).
  const doorCells = [...ts.exitCells, ...(ts.interiorDoors ?? [])];
  for (const cell of doorCells) {
    // Thin-wall house: an EDGE-door sits on the shared edge between its inner room cell and the outer street cell
    // — the leaf/frame are centred on that EDGE (half a cell out toward `edgeDir`), the leaf axis comes from the
    // dir (not the legacy blocked-neighbour heuristic), and the interactable navCell is the floored edge-midpoint
    // cell (matching the runtime's highlight + the door state sync). A legacy CELL-door (no edgeDir) is centred on
    // its own cell exactly as before.
    const dir = cell.edgeDir;
    const wx = dir ? (cell.cx + 0.5 + DOOR_DIR_DELTA[dir].dx * 0.5) * cs : (cell.cx + 0.5) * cs;
    const wz = dir ? (cell.cy + 0.5 + DOOR_DIR_DELTA[dir].dy * 0.5) * cs : (cell.cy + 0.5) * cs;
    const navCell = dir ? grid.index(Math.floor(wx / cs), Math.floor(wz / cs)) : grid.index(cell.cx, cell.cy);
    const axis = dir ? doorAxisForDir(dir) : doorAxis(grid, cell.cx, cell.cy); // 'x' = wall runs along X (leaf faces ±Z)
    // the building this door belongs to → full wall height (for the header fill) + wall tint. Every exit cell
    // lies on a building perimeter, so the lookup always resolves; the initial values are overwritten.
    let bWallH = wallH;
    let wallColor = 0x6b6e64;
    for (let bi = 0; bi < buildingsForDoors.length; bi++) {
      const bb = buildingsForDoors[bi]!.bounds;
      if (cell.cx >= bb.minCx && cell.cx <= bb.maxCx && cell.cy >= bb.minCy && cell.cy <= bb.maxCy) {
        const style = styleResolver.styleFor(buildingsForDoors[bi]!, bi);
        bWallH = wallH * Math.max(1, style.storeys);
        wallColor = style.wallColor;
        break;
      }
    }
    const leafW = cs * cfg.doorLeafWidthFraction;
    const headerY = leafHeight; // top of the doorway opening
    const half = cs / 2; // opening half-width along the wall run

    // frame posts at the opening edges + a lintel across the header.
    const postGeo = res.geo(`door.post.${cell.cx}.${cell.cy}`, new BoxGeometry(frameTh, headerY, frameTh));
    const mkPost = (ox: number, oz: number): Mesh => {
      const p = new Mesh(postGeo, frameMat);
      p.position.set(wx + ox, headerY / 2, wz + oz);
      p.castShadow = true;
      return p;
    };
    const lintelLen = cs + frameTh * 2;
    const lintelGeo = res.geo(`door.lintel.${cell.cx}.${cell.cy}`, axis === 'x'
      ? new BoxGeometry(lintelLen, frameTh, frameTh)
      : new BoxGeometry(frameTh, frameTh, lintelLen));
    const lintel = new Mesh(lintelGeo, frameMat);
    lintel.position.set(wx, headerY + frameTh / 2, wz);
    lintel.castShadow = true;
    group.add(lintel);
    if (axis === 'x') group.add(mkPost(-half, 0), mkPost(half, 0));
    else group.add(mkPost(0, -half), mkPost(0, half));

    // wall fill ABOVE the header up to the building height (covers the omitted panel over the door).
    const fillH = Math.max(0, bWallH - (headerY + frameTh));
    if (fillH > 0.01) {
      const fillGeo = res.geo(`door.header.${cell.cx}.${cell.cy}`, axis === 'x'
        ? new BoxGeometry(cs, fillH, frameTh)
        : new BoxGeometry(frameTh, fillH, cs));
      const fill = new Mesh(fillGeo, res.mat(`doorHeader.${cell.cx}.${cell.cy}`, { color: wallColor, roughness: 0.92 }));
      fill.position.set(wx, headerY + frameTh + fillH / 2, wz);
      fill.castShadow = true;
      fill.receiveShadow = true;
      group.add(fill);
    }

    // the hinged leaf: a flat slab on a PIVOT group at one vertical edge of the opening. Local leaf origin is
    // offset by half its width so the pivot sits exactly on the hinge edge; closed = pivot rotation 0.
    const leafGeo = res.geo(`door.leaf.${cell.cx}.${cell.cy}`, axis === 'x'
      ? new BoxGeometry(leafW, leafHeight, leafTh)
      : new BoxGeometry(leafTh, leafHeight, leafW));
    const leaf = new Mesh(leafGeo, leafMat);
    leaf.castShadow = true;
    const pivot = new Group();
    if (axis === 'x') {
      pivot.position.set(wx - leafW / 2, 0, wz);
      leaf.position.set(leafW / 2, leafHeight / 2, 0);
    } else {
      pivot.position.set(wx, 0, wz - leafW / 2);
      leaf.position.set(0, leafHeight / 2, leafW / 2);
    }
    pivot.add(leaf);
    group.add(pivot);
    // T113/V79: tag the leaf with its nav cell so the active-interactable silhouette GLOW resolves + hugs the
    // actual door mesh (the swinging leaf, not a box). One generic convention for every interactable kind.
    tagInteractable(leaf, navCell);
    doorLeaves.push({ navCell, pivot, openTarget: cfg.doorOpenSwingRadians, current: 0 });
  }

  // ---- WINDOWS (T108): a framed opening on a deterministic subset of facade cells. Both the placement AND
  // the initial decay state come from the shared windowPlacements() — the SAME source the sim WindowSystem
  // seeds from, so render + sim always agree (V26). Every window builds ALL its child meshes (glass pane /
  // dark void / boards) up front; the live glass/board state is REFLECTED each frame by syncWindows toggling
  // their visibility (mirrors the door-leaf pattern — the render never decides state, only reflects it, V12). ----
  const maxBoards = cfg.maxBoardsPerWindow;
  /** Build one window unit (frame + pane + void + the full board set) at a sill, tracked for syncWindows. */
  const buildWindowUnit = (navCell: number, wx: number, sillY: number, wz: number, ns: boolean, synced: boolean): void => {
    const rotY = ns ? Math.PI / 2 : 0;
    const yc = sillY + winH / 2;
    // `dx` offsets along the wall NORMAL (depth), `runOff` along the wall RUN (span); the geometry's local Z is
    // the run, so rotY maps it to world X (N/S walls) or leaves it on world Z (E/W walls). `dy` is vertical.
    const make = (geo: BufferGeometry, mat: MeshStandardMaterial, dx: number, dy: number, runOff = 0, rz = 0): Mesh => {
      const m = new Mesh(geo, mat);
      m.position.set(wx + (ns ? runOff : dx), yc + dy, wz + (ns ? dx : runOff));
      m.rotation.y = rotY;
      m.rotation.z = rz;
      m.castShadow = true;
      // T113/V79: only the SYNCED (ground-floor) sill is the live interactable — tag its meshes with the nav
      // cell so the silhouette GLOW hugs the real window unit. Upper-floor sills are cosmetic, left untagged.
      if (synced) tagInteractable(m, navCell);
      group.add(m);
      return m;
    };
    // painted frame trim — a hollow ring around the opening (rails top/bottom, stiles left/right), always present.
    make(frameRailGeo, winFrameMat, 0, winH / 2 + frameBorder / 2);
    make(frameRailGeo, winFrameMat, 0, -(winH / 2 + frameBorder / 2));
    make(frameStileGeo, winFrameMat, 0, 0, winSpan / 2 + frameBorder / 2);
    make(frameStileGeo, winFrameMat, 0, 0, -(winSpan / 2 + frameBorder / 2));
    const pane = make(paneGeo, glassMat, 0, 0); // thin glass centred at the opening mid-plane, see-through
    const voidMesh = make(voidGeo, voidMat, -voidBehind, 0); // dark backing set behind the glass (never shown)
    // up to maxBoards crossing weathered planks; syncWindows shows them by the live board count.
    const boards: Mesh[] = [];
    for (let bI = 0; bI < maxBoards; bI++) {
      const sign = bI % 2 === 0 ? 1 : -1;
      // Weathered, hand-nailed planks: a base alternating cross-tilt PLUS a deterministic random SKEW, with
      // small vertical + along-span jitter — so no board sits perfectly horizontal or evenly spaced (V26: the
      // per-(cell,board) hash is replay-stable). `make`'s rz is the in-plane tilt; runOff shifts along the span.
      const seed = (Math.imul(navCell + 1, 0x9e3779b1) ^ (bI + 1)) | 0;
      const tilt = sign * 0.09 + (hash01(seed, 1) - 0.5) * 0.34; // base cross + ±~10° random skew
      const dy = sign * winH * (0.18 - bI * 0.03) + (hash01(seed, 2) - 0.5) * winH * 0.09;
      const runOff = (hash01(seed, 3) - 0.5) * winSpan * 0.16;
      boards.push(make(boardGeo, boardMat, 0, dy, runOff, tilt));
    }
    if (synced) {
      windowMeshes.push({ navCell, pane, voidMesh, boards }); // the GROUND-floor window reflects the live 2D sim state
    } else {
      // Upper-floor windows are cosmetic — the 2D sim has ONE window-state per cell, so a stacked upper sill must
      // NOT share it (smashing the lower one used to break the upper). Render it as static intact glass, never
      // synced, so it stays independent. (Believable per-floor decay arrives with the procedural-house rework.)
      voidMesh.visible = false;
      for (const b of boards) b.visible = false;
    }
  };

  const placements = windowPlacements(ts, {
    houseVar: styleResolver.variation,
    stride: cfg.houseWindowStride,
    boardedFraction: cfg.windowBoardedFraction,
  });
  for (const p of placements) {
    const bWallH = wallH * Math.max(1, p.storeys);
    const sills = windowSillHeights(cfg.buildingWallHeightMeters, bWallH); // matches the houseBuilder wall punch
    // The interactable navCell is the floored window CENTRE (the edge midpoint for an edge-window, the cell centre
    // for a legacy cell-window) — the SAME index the runtime highlight + the render window state-sync resolve by.
    const navCell = grid.index(Math.floor(p.x / cs), Math.floor(p.z / cs));
    // Only the ground-floor sill (index 0) syncs to the sim window state; upper sills are static decoration.
    sills.forEach((sy, i) => buildWindowUnit(navCell, p.x, sy, p.z, p.ns, i === 0));
  }

  root.add(group);
  return { doorLeaves, windowMeshes };
}
