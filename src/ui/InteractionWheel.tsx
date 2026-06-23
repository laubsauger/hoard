// T60 / V43 / V1 — interaction wheel. Replaces the dummy command bar with a context menu: `E` opens it on
// the nearby structural target (the destructible wall), shows the verbs T59 resolves (gated by what the
// player holds — derived from the inventory view), and issues REAL commands via the engine handle. Greyed
// verbs show the missing requirement (V43). React owns this shell only; commands flow UI → engine (V1).

import { useEffect, useState } from 'react';
import { useInventoryView } from '../stores/react';
import { resolveInteractions, type InteractionContext, type InteractionVerb } from '../game/interaction';
import { ITEM } from '../game/inventory';
import type { EngineHandle } from './GameViewport';

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
  const playerSlots = useInventoryView((s) => s.containers.find((c) => c.container === 'player')?.slots ?? []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'KeyE') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.code === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open || !handle) return null;

  // The nearby interactable in the demo slice is the destructible wall section (a 'structure' target).
  const ctx = contextFromInventory(playerSlots.map((s) => s.item));
  const verbs = resolveInteractions({ kind: 'structure' }, ctx);

  const run = (verb: InteractionVerb): void => {
    if (!verb.enabled) return;
    if (verb.op === 'breach') handle.breach();
    else if (verb.op === 'board' || verb.op === 'reinforce') handle.board();
    setOpen(false);
  };

  return (
    <div className="hbn-wheel" role="menu" aria-label="Interact">
      <div className="hbn-wheel__panel">
        <header className="hbn-wheel__head">Wall section</header>
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
        <p className="hbn-wheel__hint">E / Esc to close</p>
      </div>
    </div>
  );
}
