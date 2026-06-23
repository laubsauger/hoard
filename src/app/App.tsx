// T6 / T38 / V1 — React shell. Owns ONLY: app lifecycle, error + loading boundaries, HUD overlay, the
// engine command bar, and the <canvas> host for the direct-Three.js engine. React NEVER owns per-frame
// world state (V1). The HUD reads narrow snapshot selectors; the world renders into the canvas outside
// React's render cycle. The engine hands back a command handle the shell uses for save/load/modify.

import { Suspense, useCallback, useState } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { GameViewport, type EngineHandle } from '../ui/GameViewport';
import { Hud } from '../ui/Hud';
import { NoiseMeter } from '../ui/NoiseMeter';
import { Controls } from '../ui/Controls';
import { AccessibilityPanel } from '../ui/AccessibilityPanel';
import { PauseMenu } from '../ui/PauseMenu';
import { InventoryMenu } from '../ui/InventoryMenu';
import { LoadingScreen } from '../ui/LoadingScreen';
import { DevToolsPanel } from '../ui/debug';
import '../ui/styles.css';

export function App() {
  const [handle, setHandle] = useState<EngineHandle | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onReady = useCallback((h: EngineHandle) => setHandle(h), []);
  const onError = useCallback((message: string) => setError(message), []);

  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingScreen />}>
        <div className="hbn-shell">
          <GameViewport onReady={onReady} onError={onError} />
          <Hud />
          <NoiseMeter />
          <Controls handle={handle} />
          <AccessibilityPanel />
          <PauseMenu />
          <InventoryMenu />
          {import.meta.env.DEV && <DevToolsPanel />}
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
