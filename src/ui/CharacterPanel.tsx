// T64 / V1 / V11 / V29 / V31 / V46 — character panel. `C` toggles it. Reads the throttled player-view
// snapshot (NOT per-frame world state): overall health, treatable conditions (bleeding/pain), and the
// survival "moodles" (hunger/thirst/fatigue/stress/encumbrance). Two-channel feedback (V46): explicit
// condition readouts here; the zombie infection stays ambiguous (no UI confirmation). Visibility lives in
// the ui store's modal stack (no dedicated PanelId). Skills are a stub until the survival sim publishes them.

import { useEffect } from 'react';
import { usePlayerView, useUi } from '../stores/react';
import { uiStore } from '../stores/ui';

const CHAR_MODAL = 'character';

/** A 0..100 stat bar. `badHigh` = red as the value rises (hunger/pain); else red as it falls (health). */
function StatBar({ label, value, badHigh = true }: { label: string; value: number | null; badHigh?: boolean }) {
  const v = value ?? 0;
  const pct = Math.max(0, Math.min(100, v));
  const severity = badHigh ? pct / 100 : 1 - pct / 100;
  const hue = 120 * (1 - severity);
  return (
    <div className="hbn-char__row">
      <span className="hbn-char__label">{label}</span>
      <span className="hbn-char__track">
        <span className="hbn-char__fill" style={{ width: `${pct}%`, background: `hsl(${hue},70%,48%)` }} />
      </span>
      <span className="hbn-char__num">{value === null ? '--' : Math.round(v)}</span>
    </div>
  );
}

export function CharacterPanel() {
  const visible = useUi((s) => s.modalStack.includes(CHAR_MODAL));
  const health = usePlayerView((s) => s.snapshot?.health ?? null);
  const bleeding = usePlayerView((s) => s.snapshot?.bleeding ?? null);
  const pain = usePlayerView((s) => s.snapshot?.pain ?? null);
  const hunger = usePlayerView((s) => s.snapshot?.hunger ?? null);
  const thirst = usePlayerView((s) => s.snapshot?.thirst ?? null);
  const fatigue = usePlayerView((s) => s.snapshot?.fatigue ?? null);
  const stress = usePlayerView((s) => s.snapshot?.stress ?? null);
  const encumbrance = usePlayerView((s) => s.snapshot?.encumbrance ?? null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'KeyC') {
        e.preventDefault();
        const ui = uiStore.getState();
        if (ui.modalStack.includes(CHAR_MODAL)) ui.popModal();
        else ui.pushModal(CHAR_MODAL);
      } else if (e.code === 'Escape' && uiStore.getState().modalStack.includes(CHAR_MODAL)) {
        uiStore.getState().popModal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!visible) return null;

  return (
    <div className="hbn-char" role="dialog" aria-label="Character">
      <div className="hbn-char__frame">
        <h2 className="hbn-char__title">Condition</h2>
        <StatBar label="Health" value={health} badHigh={false} />
        <div className="hbn-char__group">Injuries</div>
        <StatBar label="Bleeding" value={bleeding} />
        <StatBar label="Pain" value={pain} />
        <div className="hbn-char__group">Needs</div>
        <StatBar label="Hunger" value={hunger} />
        <StatBar label="Thirst" value={thirst} />
        <StatBar label="Fatigue" value={fatigue} />
        <StatBar label="Stress" value={stress} />
        <StatBar label="Encumbrance" value={encumbrance} />
        <p className="hbn-char__hint">C / Esc to close · skills pending survival sim</p>
      </div>
    </div>
  );
}
