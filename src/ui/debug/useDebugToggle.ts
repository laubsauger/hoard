// T35 / §I debug control — keybind to toggle the diagnostics overlay. Adds a window keydown listener
// for the named key while mounted. Default key is a documented constant (input remap belongs to the
// input config domain owned by another lane; the overlay just exposes a sensible default).

import { useEffect } from 'react';
import { debugViewStore } from '../../diagnostics/store';

/** Default toggle key (KeyboardEvent.key). Render integration may override via prop. */
export const DEFAULT_DEBUG_TOGGLE_KEY = 'F9';

/** Toggle the overlay when `key` is pressed. Ignores key events while typing in form fields. */
export function useDebugOverlayToggle(key: string = DEFAULT_DEBUG_TOGGLE_KEY): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== key) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      e.preventDefault();
      debugViewStore.getState().toggleOverlay();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [key]);
}
