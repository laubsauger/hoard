// T59 / T60 / T113 / V43 / V1 — context-sensitive interaction wheel. It AUTO-SHOWS the verb menu for the
// NEAREST interactable in reach (door / window / storage container / destructible wall) — the header + verbs
// follow the target's TYPE and live state (T59 resolveInteractions), gated by what the player holds (V43,
// greyed verbs show the missing requirement). The SELECTED verb is highlighted; the mouse WHEEL cycles the
// selection (driven from `viewport/input.ts` → the selection store) and tapping the interact key (F) EXECUTES
// the selected verb immediately (default = the headline/first verb) — so a single tap acts without a menu trip,
// while the list stays visible to scroll. Choosing a verb issues a REAL command via the engine handle (UI →
// engine, V1). React owns this shell only; the selection store holds primitives so selectors stay B24-safe.

import { useEffect, useRef, useState } from 'react';
import { useInventoryView, useInteractionSelect } from '../stores/react';
import {
  resolveInteractions,
  type InteractionContext,
  type InteractionVerb,
  type InteractionTargetWorld,
} from '../game/interaction';
import { ITEM } from '../game/inventory';
import { inputStore } from '../stores/input';
import { interactionSelectStore, clampIndex } from '../stores/interactionSelect';
import type { EngineHandle } from './GameViewport';

// Stable empty fallbacks — a `?? []` literal inside a selector returns a NEW array every call, which makes
// useSyncExternalStore (zustand) see an ever-changing snapshot → "getSnapshot should be cached" infinite
// re-render loop (V11/B24). Shared frozen refs keep the snapshot stable when there is nothing in reach.
const EMPTY_SLOTS: readonly { readonly item: number; readonly count: number }[] = [];
const EMPTY_VERBS: readonly InteractionVerb[] = [];

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
  const [target, setTarget] = useState<InteractionTargetWorld | null>(null);
  const playerSlots = useInventoryView((s) => s.containers.find((c) => c.container === 'player')?.slots ?? EMPTY_SLOTS);
  const selectedIndex = useInteractionSelect((s) => s.selectedIndex);

  // Poll the nearest interactable each frame so the offered verbs track the player as they move. State updates
  // only when the target's TYPE/STATE meaningfully changes (no per-frame React churn, V1/V11).
  useEffect(() => {
    if (!handle) {
      setTarget(null);
      return;
    }
    let raf = 0;
    const tick = (): void => {
      const t = handle.nearestInteractable();
      setTarget((prev) => {
        if (t === null) return prev === null ? prev : null;
        if (prev && prev.kind === t.kind && prev.access === t.access && prev.label === t.label && prev.looted === t.looted && prev.boarded === t.boarded && prev.breached === t.breached && prev.glass === t.glass && prev.boards === t.boards) {
          return prev; // unchanged — keep the same ref so React skips the re-render
        }
        return t;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [handle]);

  const ctx = contextFromInventory(playerSlots.map((s) => s.item));
  const verbs = target ? resolveInteractions(target, ctx) : EMPTY_VERBS;

  // Publish the live verb count to the selection store; it CLAMPS the selected index into range (the verb list
  // changes with state — a window's verbs differ boarded vs open). `verbs.length` only changes when the target
  // state changes (which re-renders), so this never churns per-frame.
  useEffect(() => {
    interactionSelectStore.getState().setVerbCount(verbs.length);
  }, [verbs.length]);

  // Refs so the F-key listener (registered once) reads the LIVE target/verbs without re-subscribing each render.
  const verbsRef = useRef(verbs);
  verbsRef.current = verbs;
  const targetRef = useRef(target);
  targetRef.current = target;

  // Map a chosen verb to a REAL engine command (UI → engine, V1).
  const run = (verb: InteractionVerb, t: InteractionTargetWorld): void => {
    if (!verb.enabled || !handle) return;
    switch (t.kind) {
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
        // T108 — state-driven window verbs: smash glass / board up / pry boards / climb.
        if (verb.action === 'window.smash') handle.smashWindow();
        else if (verb.action === 'window.board') handle.boardWindow();
        else if (verb.action === 'window.removeBoard') handle.removeWindowBoard();
        else if (verb.action === 'window.climb') handle.climbWindow();
        break;
    }
  };

  // F (interact) EXECUTES the selected verb (T113). Tapping acts immediately — no menu trip — on the headline
  // verb by default; once the wheel cycles the selection (scroll), F runs the highlighted one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== inputStore.getState().bindings.interact) return;
      if (e.repeat) return; // holding F must not spam the action
      const t = targetRef.current;
      const vs = verbsRef.current;
      if (!t || vs.length === 0) return;
      e.preventDefault();
      const idx = clampIndex(interactionSelectStore.getState().selectedIndex, vs.length);
      const verb = vs[idx];
      if (verb) run(verb, t);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // Deps = [handle] only: the handler reads the LIVE target/verbs via refs, so it must NOT re-subscribe each
    // render; `run` closes over the stable `handle`. Registered once per handle (re)assignment.
  }, [handle]);

  if (!target || verbs.length === 0) return null;

  const sel = clampIndex(selectedIndex, verbs.length);

  return (
    <div className="hbn-wheel" role="menu" aria-label="Interact">
      <div className="hbn-wheel__panel">
        <header className="hbn-wheel__head">{target.label}</header>
        {verbs.map((v, i) => (
          <button
            key={v.id}
            type="button"
            role="menuitem"
            aria-checked={i === sel}
            className={`hbn-wheel__verb${v.enabled ? '' : ' is-disabled'}${i === sel ? ' is-selected' : ''}`}
            onClick={() => run(v, target)}
            disabled={!v.enabled}
            title={v.reason ?? v.label}
          >
            <span className="hbn-wheel__verb-label">{v.label}</span>
            {!v.enabled && v.reason && <span className="hbn-wheel__verb-reason">{v.reason}</span>}
          </button>
        ))}
        <p className="hbn-wheel__hint">{verbs.length > 1 ? 'scroll to choose · F to use' : 'F to use'}</p>
      </div>
    </div>
  );
}
