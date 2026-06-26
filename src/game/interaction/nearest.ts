// T60 — nearest-interactable resolution + the "{key} to {action}" context prompt. Pure + runtime-independent
// (unit-testable, reused by the HUD prompt + the interaction wheel): given the live interactables and the
// player position, pick the NEAREST one in reach and derive the primary verb phrase to advertise. The wheel
// still enumerates ALL verbs (resolveInteractions, gated by what the player holds); this picks the headline
// action the prompt shows and the TYPE whose verbs the wheel should offer (door vs container vs window vs wall).

import type { InteractionTarget, TargetKind } from './resolve';

/** An interactable placed in the world (its planar centre) — what `nearestInteractable` ranks. */
export interface InteractionTargetWorld extends InteractionTarget {
  /** World-plane position used for the distance test. */
  readonly x: number;
  readonly z: number;
  /** Human label for the target itself (e.g. "Door", "Kitchen Cupboard", "Wall section"). */
  readonly label: string;
  /** Wall orientation (rad) for a door/window/wall outline: 0 = the wall runs along world X, π/2 = along Z.
   *  Rotates the highlight box so its thin axis aligns with the wall normal (hugs the leaf/pane). Omit for
   *  axis-aligned objects (cupboard/corpse). */
  readonly orientationRad?: number;
}

/**
 * The placed + SIZED active interactable the renderer outlines (T60/V29): world centre + an axis-aligned box
 * roughly bounding the target, plus its kind (the highlight colour-codes by kind). One at a time — the nearest
 * target in reach. Produced by `highlightBoxFor` so the transform is pure + headless-testable.
 */
export interface InteractionHighlightTarget {
  readonly kind: TargetKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  /** Yaw (rad) the outline box is rotated by so a thin door/window/wall hugs its wall (thin axis = wall normal,
   *  wide axis = wall run). 0 for axis-aligned objects (cupboard/corpse). */
  readonly rotationY: number;
  /** Nav cell the target occupies — the GENERIC, data-driven key the silhouette-GLOW outline (T113/V79) resolves
   *  the target's render mesh(es) by (scene builders tag each interactable mesh with the same nav cell, no
   *  per-kind switch). The pure `highlightBoxFor` omits it (it has no grid); the runtime attaches it. When no
   *  tagged mesh exists for the cell (an INSTANCED corpse/zombie) the view falls back to the box. */
  readonly navCell: number;
}

/** Physical dims used to size a target's highlight box (typed config + scene cell size — no magic numbers). The
 *  per-kind boxes are TIGHT to the real mesh (a thin leaf/pane on the wall, a window up at its sill, a low body)
 *  so the outline hugs the object instead of a fat floor-to-ceiling nav-cell cube. */
export interface HighlightDims {
  /** Nav cell edge (m) — the WALL-RUN width of a door/window/wall outline. */
  readonly navCellSize: number;
  /** Authored building wall height (m) — drives door/wall outline height + the window sill. */
  readonly wallHeightMeters: number;
  /** Thin depth (m) along the wall NORMAL for door/window/wall outlines (a leaf/pane is thin). */
  readonly thinMeters: number;
  /** Edge (m) of the low box around a toppled corpse. */
  readonly corpseSizeMeters: number;
  readonly cupboardWidthMeters: number;
  readonly cupboardDepthMeters: number;
  readonly cupboardHeightMeters: number;
}

/**
 * Map a world interactable to a TIGHT highlight box (pure) that hugs the real mesh — not a fat nav-cell cube:
 *  • door   — a thin leaf, ~0.85 cell wide, ~0.85 wall-height tall, on the floor, rotated to the wall (rotationY).
 *  • window — a thin pane, ~0.7 cell wide, ~0.4 wall-height tall, lifted to its SILL (≈0.3 wall-height), rotated.
 *  • structure (wall) — a thin slab, one cell wide, full wall height, rotated to the wall.
 *  • container — the cabinet dims (already tight).
 *  • corpse — a low body box on the ground.
 * `target.orientationRad` (0 = wall runs along world X, π/2 = along Z) rotates the thin/wide axes onto the wall.
 */
export function highlightBoxFor(target: InteractionTargetWorld, dims: HighlightDims): Omit<InteractionHighlightTarget, 'navCell'> {
  const rot = target.orientationRad ?? 0;
  switch (target.kind) {
    case 'container':
      return { kind: 'container', x: target.x, y: dims.cupboardHeightMeters / 2, z: target.z, sizeX: dims.cupboardWidthMeters, sizeY: dims.cupboardHeightMeters, sizeZ: dims.cupboardDepthMeters, rotationY: 0 };
    case 'corpse': {
      const s = dims.corpseSizeMeters;
      return { kind: 'corpse', x: target.x, y: s * 0.3, z: target.z, sizeX: s, sizeY: s * 0.6, sizeZ: s, rotationY: 0 };
    }
    case 'window': {
      // Mirror the REAL window opening (render/scene/builders/windowGeometry: WINDOW_HEIGHT_FRACTION 0.4 +
      // WINDOW_SILL_FRACTION 0.3 + WINDOW_SPAN_FRACTION 0.7) so the fallback box hugs the actual pane — sill at
      // 0.3 wall-height, opening 0.4 tall → centre 0.5 wall-height (NOT the old 0.65 that floated above the pane).
      const h = dims.wallHeightMeters * 0.4;
      const sill = dims.wallHeightMeters * 0.3;
      // sizeX = wall RUN width, sizeZ = thin (wall normal); rotationY turns it onto the wall.
      return { kind: 'window', x: target.x, y: sill + h / 2, z: target.z, sizeX: dims.navCellSize * 0.7, sizeY: h, sizeZ: dims.thinMeters, rotationY: rot };
    }
    case 'door': {
      const h = dims.wallHeightMeters * 0.85;
      return { kind: 'door', x: target.x, y: h / 2, z: target.z, sizeX: dims.navCellSize * 0.85, sizeY: h, sizeZ: dims.thinMeters, rotationY: rot };
    }
    case 'radio': {
      // T40 — a small table-top appliance box, lifted to roughly waist height so the glow hugs the radio mesh.
      const w = dims.cupboardWidthMeters * 0.5;
      const h = dims.cupboardHeightMeters * 0.32;
      const sill = dims.cupboardHeightMeters * 0.5;
      return { kind: 'radio', x: target.x, y: sill + h / 2, z: target.z, sizeX: w, sizeY: h, sizeZ: w, rotationY: 0 };
    }
    default: {
      // structure (the destructible wall section) — a thin full-height slab one cell wide on the wall.
      const h = dims.wallHeightMeters;
      return { kind: target.kind, x: target.x, y: h / 2, z: target.z, sizeX: dims.navCellSize, sizeY: h, sizeZ: dims.thinMeters, rotationY: rot };
    }
  }
}

/** The nearest interactable to a point, with its planar distance. */
export interface NearestInteractable {
  readonly target: InteractionTargetWorld;
  readonly distanceMeters: number;
}

/** The world-anchored / HUD prompt for the nearest interactable: "{key} to {action}". */
export interface InteractionPrompt {
  /** The key the player presses (display string, e.g. "E"). */
  readonly key: string;
  /** The verb phrase, e.g. "open door", "search", "climb through", "breach". */
  readonly action: string;
  /** The target's own label. */
  readonly label: string;
  /** The target kind — drives which verbs the wheel offers when opened. */
  readonly kind: TargetKind;
  /** Where the prompt is anchored (world plane). */
  readonly x: number;
  readonly z: number;
}

/**
 * The NEAREST interactable to (x,z) within `rangeMeters`, or null when nothing is in reach. Ties are broken
 * by input order (first wins) so the result is deterministic. Pure — no runtime/render coupling.
 */
export function nearestInteractable(
  targets: readonly InteractionTargetWorld[],
  x: number,
  z: number,
  rangeMeters: number,
): NearestInteractable | null {
  let best: NearestInteractable | null = null;
  for (const target of targets) {
    const dist = Math.hypot(target.x - x, target.z - z);
    if (dist > rangeMeters) continue;
    if (!best || dist < best.distanceMeters) best = { target, distanceMeters: dist };
  }
  return best;
}

/**
 * HOVER pick (T136): among the interactables WITHIN `rangeMeters` of the player (x,z), the one nearest the
 * POINTER world point (px,pz) — so the MOUSE chooses which of several in-reach targets is selected, instead of
 * always the closest-to-the-player one (tedious when two sit side by side). `distanceMeters` stays the
 * player→target distance (the prompt anchor / reach readout). Ties break by input order. Pure — no render/runtime
 * coupling. Nothing in reach → null (the caller then falls back to `nearestInteractable`, e.g. no pointer yet).
 */
export function hoveredInteractable(
  targets: readonly InteractionTargetWorld[],
  x: number,
  z: number,
  rangeMeters: number,
  pointerX: number,
  pointerZ: number,
  hoverRadiusMeters = Infinity,
): NearestInteractable | null {
  let best: NearestInteractable | null = null;
  let bestPointerDist = Infinity;
  for (const target of targets) {
    const reach = Math.hypot(target.x - x, target.z - z);
    if (reach > rangeMeters) continue; // must be IN REACH of the player to interact
    const toPointer = Math.hypot(target.x - pointerX, target.z - pointerZ);
    if (toPointer > hoverRadiusMeters) continue; // pointer not actually OVER/near this target (T136 hold-last)
    if (toPointer < bestPointerDist) {
      bestPointerDist = toPointer;
      best = { target, distanceMeters: reach };
    }
  }
  return best;
}

/**
 * The primary verb PHRASE to advertise for a target, by its kind + live state (T59/T60). This is the headline
 * action the prompt shows; the wheel still offers the full gated verb list. Never throws — an unknown kind
 * falls back to a generic "interact".
 */
export function interactionActionLabel(target: InteractionTarget): string {
  switch (target.kind) {
    case 'door':
      if (target.access === 'locked') return 'unlock door';
      return target.access === 'open' ? 'close door' : 'open door';
    case 'window':
      // State-driven (T108): boarded → pry it open; intact pane → smash it; an opening → climb through.
      if ((target.boards ?? 0) > 0) return 'remove boards';
      if (target.glass === 'intact') return 'smash glass';
      return 'climb through';
    case 'container':
      return target.looted ? 'search again' : 'search';
    case 'corpse':
      return 'search body';
    case 'structure':
      return target.boarded ? 'breach' : 'breach wall';
    case 'radio':
      // T40 — headline verb tracks the objective stage the radio is in.
      switch (target.radioStage) {
        case 'collect': return 'install part';
        case 'repair': return target.repairing ? 'stop repair' : 'repair radio';
        case 'call': return 'call evacuation';
        default: return 'use radio';
      }
  }
}

/** Build the "{key} to {action}" prompt for a world target. Pure — the caller supplies the bound key glyph. */
export function interactionPrompt(target: InteractionTargetWorld, key: string): InteractionPrompt {
  return {
    key,
    action: interactionActionLabel(target),
    label: target.label,
    kind: target.kind,
    x: target.x,
    z: target.z,
  };
}
