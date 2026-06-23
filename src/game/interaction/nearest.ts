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
}

/** Physical dims used to size a target's highlight box (typed config + scene cell size — no magic numbers). */
export interface HighlightDims {
  /** Nav cell edge (m) — the planar footprint of a door/window/wall/corpse highlight box. */
  readonly navCellSize: number;
  /** Height (m) of a door/window/wall/corpse highlight box (the cupboard uses its own dims below). */
  readonly defaultHeightMeters: number;
  readonly cupboardWidthMeters: number;
  readonly cupboardDepthMeters: number;
  readonly cupboardHeightMeters: number;
}

/**
 * Map a world interactable to its highlight box (pure). A container is sized to the cabinet dims so the
 * outline hugs the cupboard mesh; every other kind gets a one-cell footprint at the configured height. The
 * box rests on the floor (centre at half its height) so it reads as a standing object, not a buried one.
 */
export function highlightBoxFor(target: InteractionTargetWorld, dims: HighlightDims): InteractionHighlightTarget {
  if (target.kind === 'container') {
    return {
      kind: 'container',
      x: target.x,
      y: dims.cupboardHeightMeters / 2,
      z: target.z,
      sizeX: dims.cupboardWidthMeters,
      sizeY: dims.cupboardHeightMeters,
      sizeZ: dims.cupboardDepthMeters,
    };
  }
  return {
    kind: target.kind,
    x: target.x,
    y: dims.defaultHeightMeters / 2,
    z: target.z,
    sizeX: dims.navCellSize,
    sizeY: dims.defaultHeightMeters,
    sizeZ: dims.navCellSize,
  };
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
      return 'climb through';
    case 'container':
      return target.looted ? 'search again' : 'search';
    case 'corpse':
      return 'search body';
    case 'structure':
      return target.boarded ? 'breach' : 'breach wall';
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
