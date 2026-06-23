// T49 / V1 / V29 — pause menu. Shown when the session phase is 'paused' (ESC toggles it; the sim stops
// advancing in the viewport while paused). React owns this shell affordance only — it never touches
// per-frame world state. The session phase is the single source of truth shared with the engine loop.

import { useSession } from '../stores/react';
import { sessionStore } from '../stores/session';

export function PauseMenu() {
  const paused = useSession((s) => s.phase === 'paused');
  if (!paused) return null;

  const resume = () => sessionStore.getState().setPhase('playing');

  return (
    <div className="hbn-pause" role="dialog" aria-modal="true" aria-label="Game paused">
      <div className="hbn-pause__panel">
        <h2 className="hbn-pause__title">Paused</h2>
        <button type="button" className="hbn-pause__btn hbn-pause__btn--primary" onClick={resume} autoFocus>
          Resume
        </button>
        <button type="button" className="hbn-pause__btn" onClick={() => sessionStore.getState().setPhase('menu')}>
          Quit to menu
        </button>
        <p className="hbn-pause__hint">Esc to resume · settings in the accessibility panel</p>
      </div>
    </div>
  );
}
