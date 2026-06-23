// T59 / T60 / V43 / V1 — context-sensitive interaction wheel. `E` opens a verb menu for the NEAREST
// interactable target (door / window / storage container / destructible wall), not a hardcoded one: the menu
// header + verbs follow the target's TYPE and live state (T59 resolveInteractions), gated by what the player
// holds (derived from the inventory view — greyed verbs show the missing requirement, V43). Choosing a verb
// issues a REAL command via the engine handle (UI → engine, V1). React owns this shell only.

import { useEffect, useRef, useState } from 'react';
import { useInventoryView } from '../stores/react';
import {
  resolveInteractions,
  type InteractionContext,
  type InteractionVerb,
  type InteractionTargetWorld,
} from '../game/interaction';
import { ITEM } from '../game/inventory';
import { inputStore } from '../stores/input';
import type { EngineHandle } from './GameViewport';

// Stable empty fallback — a `?? []` literal inside the selector returns a NEW array every call, which makes
// useSyncExternalStore (zustand) see an ever-changing snapshot → "getSnapshot should be cached" infinite
// re-render loop (V11). A shared frozen ref keeps the snapshot stable when there is no player container yet.
const EMPTY_SLOTS: readonly { readonly item: number; readonly count: number }[] = [];

/** Derive the tool/material context from the player's inventory stacks (T59 gating). */
function contextFromInventory(playerItems: readonly number[]): InteractionContext {
  const has = (id: number): boolean => playerItems.includes(id);
  return {
    hasHammer: has(ITEM.Hammer),
    hasPlanks: has(ITEM.WoodPlank),
    hasTool: has(ITEM.Crowbar) || has(ITEM.FireAxe) || has(ITEM.Hammer),
    hasKey: false,
  };
}

export function InteractionWheel({ handle }: { handle: EngineHandle | null }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<InteractionTargetWorld | null>(null);
  const playerSlots = useInventoryView((s) => s.containers.find((c) => c.container === 'player')?.slots ?? EMPTY_SLOTS);
  const rafRef = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Use the rebindable `interact` binding (default KeyF), NOT a hardcoded KeyE — KeyE is camera rotate-CW,
      // so hardcoding it made one key both rotate the camera AND open the wheel (collision).
      if (e.code === inputStore.getState().bindings.interact) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.code === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // While the wheel is open, poll the nearest interactable each frame so the offered verbs track the player as
  // they move. State is only updated when the target's TYPE/STATE meaningfully changes (no per-frame churn).
  useEffect(() => {
    if (!open || !handle) {
      setTarget(null);
      return;
    }
    const tick = (): void => {
      const t = handle.nearestInteractable();
      setTarget((prev) => {
        if (t === null) return prev === null ? prev : null;
        if (prev && prev.kind === t.kind && prev.access === t.access && prev.label === t.label && prev.looted === t.looted && prev.boarded === t.boarded && prev.breached === t.breached && prev.glass === t.glass && prev.boards === t.boards) {
          return prev; // unchanged — keep the same ref so React skips the re-render
        }
        return t;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [open, handle]);

  if (!open || !handle) return null;

  if (!target) {
    return (
      <div className="hbn-wheel" role="menu" aria-label="Interact">
        <div className="hbn-wheel__panel">
          <header className="hbn-wheel__head">Nothing in reach</header>
          <p className="hbn-wheel__hint">Esc to close</p>
        </div>
      </div>
    );
  }

  const ctx = contextFromInventory(playerSlots.map((s) => s.item));
  const verbs = resolveInteractions(target, ctx);

  const run = (verb: InteractionVerb): void => {
    if (!verb.enabled) return;
    switch (target.kind) {
      case 'door':
        if (verb.op === 'open' || verb.op === 'close') handle.toggleNearestDoor();
        break;
      case 'container':
        if (verb.action === 'container.loot') handle.loot();
        break;
      case 'structure':
        if (verb.op === 'breach') handle.breach();
        else if (verb.op === 'board' || verb.op === 'reinforce') handle.board();
        break;
      case 'window':
        // T108 — state-driven window verbs (see resolveInteractions): smash glass / board up / pry boards / climb.
        if (verb.action === 'window.smash') handle.smashWindow();
        else if (verb.action === 'window.board') handle.boardWindow();
        else if (verb.action === 'window.removeBoard') handle.removeWindowBoard();
        else if (verb.action === 'window.climb') handle.climbWindow();
        break;
    }
    setOpen(false);
  };

  return (
    <div className="hbn-wheel" role="menu" aria-label="Interact">
      <div className="hbn-wheel__panel">
        <header className="hbn-wheel__head">{target.label}</header>
        {verbs.map((v) => (
          <button
            key={v.id}
            type="button"
            role="menuitem"
            className={`hbn-wheel__verb${v.enabled ? '' : ' is-disabled'}`}
            onClick={() => run(v)}
            disabled={!v.enabled}
            title={v.reason ?? v.label}
          >
            <span className="hbn-wheel__verb-label">{v.label}</span>
            {!v.enabled && v.reason && <span className="hbn-wheel__verb-reason">{v.reason}</span>}
          </button>
        ))}
        <p className="hbn-wheel__hint">Esc to close</p>
      </div>
    </div>
  );
}
