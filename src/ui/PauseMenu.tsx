// T49 / V1 / V12 — pause menu. Shown when session.paused is true (ESC toggles it; the sim HALTS in the
// viewport loop while paused — not just the UI). React owns this shell affordance only — it never touches
// per-frame world state. The session `paused` flag is the single source of truth shared with the engine
// loop; the single-player time-scale (slowdown) is honoured by the same loop.

import { useSession, useUi } from '../stores/react';
import { sessionStore, TIME_SCALE_PRESETS } from '../stores/session';
import { uiStore } from '../stores/ui';

export function PauseMenu() {
  const paused = useSession((s) => s.paused);
  const timeScale = useSession((s) => s.timeScale);
  const settingsOpen = useUi((s) => s.activePanel === 'settings');
  if (!paused) return null;

  const sess = sessionStore.getState();
  const resume = () => sess.setPaused(false);
  // Toggle: the Settings button OPENS the panel and CLOSES it on a second press (was open-only, so a second
  // click did nothing — the panel's own × closed it but the button itself felt dead).
  const toggleSettings = () => {
    const ui = uiStore.getState();
    if (ui.activePanel === 'settings') ui.closePanel();
    else ui.openPanel('settings');
  };
  const quit = () => {
    sess.setPaused(false);
    sess.setPhase('menu');
  };

  return (
    <div className="hbn-pause" role="dialog" aria-modal="true" aria-label="Game paused">
      <div className="hbn-pause__panel">
        <h2 className="hbn-pause__title">Paused</h2>
        <button type="button" className="hbn-pause__btn hbn-pause__btn--primary" onClick={resume} autoFocus>
          Resume
        </button>
        <button type="button" className="hbn-pause__btn" onClick={toggleSettings} aria-expanded={settingsOpen}>
          Settings
        </button>
        <button type="button" className="hbn-pause__btn" onClick={quit}>
          Quit to menu
        </button>

        <div className="hbn-pause__speed" role="group" aria-label="Simulation speed">
          <span className="hbn-pause__speed-label">Speed</span>
          <div className="hbn-pause__speed-btns">
            {TIME_SCALE_PRESETS.map((scale) => (
              <button
                key={scale}
                type="button"
                className={`hbn-pause__chip${timeScale === scale ? ' is-active' : ''}`}
                aria-pressed={timeScale === scale}
                onClick={() => sess.setTimeScale(scale)}
              >
                {scale}×
              </button>
            ))}
          </div>
        </div>

        <p className="hbn-pause__hint">Esc to resume · speed applies on resume</p>
      </div>
    </div>
  );
}
