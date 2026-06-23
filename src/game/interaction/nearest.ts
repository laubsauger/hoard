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
