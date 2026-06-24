// T60 / T113 / V1 — context-sensitive interaction PROMPT, now WORLD-ANCHORED. A small "{key} to {action}" hint
// that floats NEXT TO the actual interactable (its world position projected through the live tactical camera to
// screen px) instead of being pinned at the screen bottom — so the player sees WHICH object the prompt refers to.
// It polls the engine handle each frame: the prompt TEXT re-renders only when it changes (no per-frame React
// churn, V1/V11), while the SCREEN POSITION is updated imperatively on the DOM node each frame (it tracks the
// camera/player without re-rendering). Pure read of sim state (V1: React never writes world state here).

import { useEffect, useRef, useState } from 'react';
import { clampScreenPoint } from './viewport/worldToScreen';
import type { EngineHandle } from './GameViewport';

export function InteractionPrompt({ handle }: { handle: EngineHandle | null }) {
  const [prompt, setPrompt] = useState<{ key: string; action: string } | null>(null);
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!handle) {
      setPrompt(null);
      return;
    }
    let raf = 0;
    const { anchorHeightMeters, offsetPx, marginPx } = handle.promptLayout;
    const tick = (): void => {
      const p = handle.nearestInteraction();
      // TEXT: change-gated so React only re-renders when the advertised action/key changes (keep the ref).
      setPrompt((prev) => {
        if (p === null) return prev === null ? prev : null;
        if (prev && prev.key === p.key && prev.action === p.action) return prev;
        return { key: p.key, action: p.action };
      });
      // POSITION: imperative each frame (no React churn). Anchor the bubble above the item's world point.
      const el = elRef.current;
      if (p && el) {
        const s = handle.worldToScreen(p.x, anchorHeightMeters, p.z);
        if (s) {
          const c = clampScreenPoint({ x: s.x, y: s.y - offsetPx, behind: false }, window.innerWidth, window.innerHeight, marginPx);
          el.style.left = `${c.x}px`;
          el.style.top = `${c.y}px`;
          el.style.visibility = 'visible';
        } else {
          el.style.visibility = 'hidden'; // off-screen / behind the camera
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [handle]);

  if (!prompt) return null;

  // `visibility: hidden` initially so the FIRST frame (before the rAF positions it) never flashes at 0,0.
  return (
    <div ref={elRef} className="hbn-prompt hbn-prompt--world" role="status" aria-live="polite" style={{ visibility: 'hidden' }}>
      <kbd className="hbn-prompt__key">{prompt.key}</kbd>
      <span className="hbn-prompt__action">to {prompt.action}</span>
    </div>
  );
}
