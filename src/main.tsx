import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { bootSet } from './boot/bootSplash';

// Bundle parsed + app code executing — past the big download, now mounting (GameViewport drives the rest).
bootSet(0.2, 'Starting engine…');

const root = document.getElementById('root');
if (!root) throw new Error('root element #root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
