// T6 / T38 / V1 — React shell. Owns ONLY: app lifecycle, error + loading boundaries, HUD overlay, the
// engine command bar, and the <canvas> host for the direct-Three.js engine. React NEVER owns per-frame
// world state (V1). The HUD reads narrow snapshot selectors; the world renders into the canvas outside
// React's render cycle. The engine hands back a command handle the shell uses for save/load/modify.

import { Suspense, useCallback, useEffect, useState } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { GameViewport, type EngineHandle } from '../ui/GameViewport';
import { Hud } from '../ui/Hud';
import { NoiseMeter } from '../ui/NoiseMeter';
import { DamageVignette } from '../ui/DamageVignette';
import { Controls } from '../ui/Controls';
import { SettingsPanel } from '../ui/SettingsPanel';
import { PauseMenu } from '../ui/PauseMenu';
import { InventoryMenu } from '../ui/InventoryMenu';
import { CharacterPanel } from '../ui/CharacterPanel';
import { InteractionWheel } from '../ui/InteractionWheel';
import { InteractionPrompt } from '../ui/InteractionPrompt';
import { LoadingScreen } from '../ui/LoadingScreen';
import { DevToolsPanel } from '../ui/debug';
import '../ui/styles.css';

export function App() {
  const [handle, setHandle] = useState<EngineHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Dev tools are always on in a DEV build; in PROD they're hidden until summoned with the backtick (`) key, so
  // the deployed build stays clean but the panel is one keypress away for debugging on the live site.
  const [devToolsOpen, setDevToolsOpen] = useState(false); // closed by default — toggle it open with the dev-tools key

  const onReady = useCallback((h: EngineHandle) => setHandle(h), []);
  const onError = useCallback((message: string) => setError(message), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Backtick toggles the dev-tools panel. Ignore it while typing in a field so it never eats text input.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.code === 'Backquote') {
        e.preventDefault();
        setDevToolsOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingScreen />}>
        <div className="hbn-shell">
          <GameViewport onReady={onReady} onError={onError} />
          <Hud />
          <NoiseMeter />
          <DamageVignette />
          <Controls handle={handle} />
          <SettingsPanel />
          <PauseMenu />
          <InventoryMenu handle={handle} />
          <CharacterPanel handle={handle} />
          <InteractionPrompt handle={handle} />
          <InteractionWheel handle={handle} />
          {devToolsOpen && <DevToolsPanel />}
          {error && (
            <div className="hbn-error" role="alert">
              <h1>Engine unavailable</h1>
              <p>{error}</p>
            </div>
          )}
        </div>
      </Suspense>
    </ErrorBoundary>
  );
}
