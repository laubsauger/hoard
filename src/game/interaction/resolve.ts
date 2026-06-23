// T59 / V43 — interaction resolution. Pure: given a TARGET + what the player HOLDS/knows, enumerate the
// valid context verbs (PZ-style filtered menu). Never offer an action the player can't do — instead mark
// it disabled with the missing requirement (the UI greys it). Runtime-independent so it's unit-testable
// and reused by the interaction wheel (T60); the caller maps each chosen verb to a contract command.

import type { StructureOp } from '@/game/core/contracts';

/** The kind of thing the player is facing. */
export type TargetKind = 'door' | 'window' | 'container' | 'corpse' | 'structure';

/** A window's glass state (T108). `open` = authored glassless; `smashed` = a once-intact pane broken. */
export type WindowGlass = 'intact' | 'open' | 'smashed';

/** Live state of the target relevant to which verbs apply. */
export interface InteractionTarget {
  readonly kind: TargetKind;
  /** Door/window access state. */
  readonly access?: 'open' | 'closed' | 'locked';
  readonly boarded?: boolean;
  readonly breached?: boolean;
  /** Container/corpse already emptied. */
  readonly looted?: boolean;
  /** Window glass state (T108) — drives the state-sensitive window verbs. */
  readonly glass?: WindowGlass;
  /** Window board count (T108) — boarded windows offer "remove boards" first. */
  readonly boards?: number;
}

/** What the player has on hand / knows — gates tool/material/skill-dependent verbs. */
export interface InteractionContext {
  readonly hasHammer?: boolean;
  readonly hasPlanks?: boolean;
  readonly hasTool?: boolean; // crowbar / axe etc for breaching
  readonly hasKey?: boolean;
}

/** A resolved verb. `command` is the contract op to issue when enabled (structure verbs); else an action id. */
export interface InteractionVerb {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  /** Why it's disabled (shown greyed) — present only when `enabled` is false. */
  readonly reason?: string;
  /** For structural verbs, the StructureOp to dispatch. */
  readonly op?: StructureOp;
  /** Non-structural action id (loot/search) for `confirmAction`. */
  readonly action?: string;
}

function gated(id: string, label: string, ok: boolean, missing: string, op?: StructureOp): InteractionVerb {
  const base = op !== undefined ? { op } : {};
  return ok ? { id, label, enabled: true, ...base } : { id, label, enabled: false, reason: missing, ...base };
}

/**
 * Enumerate the valid interaction verbs for a target given the player's context (V43). Disabled verbs carry
 * the missing requirement; enabled structural verbs carry their `StructureOp`. Order = most common first.
 */
export function resolveInteractions(target: InteractionTarget, ctx: InteractionContext = {}): InteractionVerb[] {
  const verbs: InteractionVerb[] = [];
  switch (target.kind) {
    case 'door': {
      if (target.access === 'open') verbs.push({ id: 'close', label: 'Close', enabled: true, op: 'close' });
      else if (target.access === 'closed') {
        verbs.push({ id: 'open', label: 'Open', enabled: true, op: 'open' });
        verbs.push({ id: 'lock', label: 'Lock', enabled: true, op: 'lock' });
      } else if (target.access === 'locked') {
        verbs.push(gated('unlock', 'Unlock', !!ctx.hasKey, 'need a key', 'unlock'));
      }
      if (!target.boarded) verbs.push(gated('board', 'Board', !!(ctx.hasHammer && ctx.hasPlanks), 'need hammer + planks', 'board'));
      if (!target.breached) verbs.push(gated('breach', 'Break down', !!ctx.hasTool, 'need a tool', 'breach'));
      break;
    }
    case 'window': {
      // State-driven (T108): a boarded window must be pried open first; an intact pane can be smashed; an
      // open/smashed window can be climbed through OR boarded up (gated on a hammer + planks).
      const boards = target.boards ?? 0;
      if (boards > 0) {
        verbs.push({ id: 'removeBoard', label: 'Remove boards', enabled: true, action: 'window.removeBoard' });
      } else if (target.glass === 'intact') {
        verbs.push({ id: 'smash', label: 'Smash glass', enabled: true, action: 'window.smash' });
      } else {
        verbs.push({ id: 'climb', label: 'Climb through', enabled: true, action: 'window.climb' });
        verbs.push(
          ctx.hasHammer && ctx.hasPlanks
            ? { id: 'board', label: 'Board up', enabled: true, action: 'window.board' }
            : { id: 'board', label: 'Board up', enabled: false, reason: 'need hammer + planks' },
        );
      }
      break;
    }
    case 'container': {
      verbs.push({ id: 'loot', label: target.looted ? 'Search again' : 'Open / Loot', enabled: true, action: 'container.loot' });
      break;
    }
    case 'corpse': {
      verbs.push({ id: 'search', label: 'Search body', enabled: true, action: 'corpse.search' });
      break;
    }
    case 'structure': {
      if (!target.breached) verbs.push(gated('breach', 'Breach', !!ctx.hasTool, 'need a tool', 'breach'));
      if (!target.boarded && !target.breached) {
        verbs.push(gated('board', 'Board', !!(ctx.hasHammer && ctx.hasPlanks), 'need hammer + planks', 'board'));
        verbs.push(gated('reinforce', 'Reinforce', !!(ctx.hasHammer && ctx.hasPlanks), 'need hammer + planks', 'reinforce'));
      }
      break;
    }
  }
  return verbs;
}
