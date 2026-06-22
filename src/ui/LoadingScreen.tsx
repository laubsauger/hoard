// T6 — loading boundary fallback. Reads only the UI store loading progress (narrow selector, V11).

import { useUi } from '../stores/react';

export function LoadingScreen() {
  const progress = useUi((s) => s.loadingProgress);
  return (
    <div className="hbn-loading" role="status" aria-live="polite">
      <div className="hbn-loading__title">Ho(a)rdish by Nature</div>
      <div className="hbn-loading__bar">
        <div className="hbn-loading__fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <div className="hbn-loading__pct">{Math.round(progress * 100)}%</div>
    </div>
  );
}
