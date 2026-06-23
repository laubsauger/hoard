// T60 / V1 — context-sensitive interaction PROMPT. A small HUD hint that advertises the action for the
// NEAREST interactable in reach: "{key} to {action}" (e.g. "E to open door", "E to search", "E to climb
// through", "E to breach wall"). It polls the engine handle each frame and re-renders ONLY when the prompt
// text changes (so it tracks the player as they move without per-frame React churn). Pure read of sim state
// (V1: React never writes world state here) — pressing the key opens the interaction wheel for that target.

import { useEffect, useState } from 'react';
import type { EngineHandle } from './GameViewport';

export function InteractionPrompt({ handle }: { handle: EngineHandle | null }) {
  const [prompt, setPrompt] = useState<{ key: string; action: string } | null>(null);

  useEffect(() => {
    if (!handle) {
      setPrompt(null);
      return;
    }
    let raf = 0;
    const tick = (): void => {
      const p = handle.nearestInteraction();
      setPrompt((prev) => {
        if (p === null) return prev === null ? prev : null;
        if (prev && prev.key === p.key && prev.action === p.action) return prev; // unchanged — keep ref
        return { key: p.key, action: p.action };
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [handle]);

  if (!prompt) return null;

  return (
    <div className="hbn-prompt" role="status" aria-live="polite">
      <kbd className="hbn-prompt__key">{prompt.key}</kbd>
      <span className="hbn-prompt__action">to {prompt.action}</span>
    </div>
  );
}
