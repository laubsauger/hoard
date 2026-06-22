// T6 / V1 — React shell. Owns ONLY: app lifecycle, error + loading boundaries, HUD overlay, and the
// <canvas> host for the direct-Three.js engine. React NEVER owns per-frame world state (V1). The HUD
// reads narrow snapshot selectors; the world renders into the canvas outside React's render cycle.

import { Suspense } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { GameViewport } from '../ui/GameViewport';
import { Hud } from '../ui/Hud';
import { LoadingScreen } from '../ui/LoadingScreen';
import '../ui/styles.css';

export function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingScreen />}>
        <div className="hbn-shell">
          <GameViewport />
          <Hud />
        </div>
      </Suspense>
    </ErrorBoundary>
  );
}
