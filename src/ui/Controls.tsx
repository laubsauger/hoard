// T38 — the slice's interactive command bar. React owns this shell affordance (V1): every button issues
// validated INTENT to the engine through the EngineHandle (save/load full SaveDelta, structural modify,
// weather), never touching per-frame world state. Pointer-events are enabled here (the HUD stays inert).

import { useState } from 'react';
import type { EngineHandle } from './GameViewport';
import { WEATHER_PROFILES, type WeatherProfile } from '../config/domains/weather';
import { uiStore } from '../stores/ui';

export function Controls({ handle }: { handle: EngineHandle | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherProfile>('clear');
  if (!handle) return null;

  const run = (label: string, fn: () => void | Promise<void>) => async () => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="hbn-controls" aria-label="engine controls">
      <div className="hbn-controls__group">
        <button onClick={run('breach', () => handle.breach())}>Breach wall</button>
        <button onClick={run('board', () => handle.board())}>Board wall</button>
        <button onClick={run('ignite', () => handle.ignite())}>Ignite route</button>
      </div>
      <div className="hbn-controls__group" aria-label="objective">
        <button onClick={run('part', () => handle.collectPart())}>Find part</button>
        <button onClick={run('repair', () => handle.repairRadio())}>Repair radio</button>
        <button onClick={run('advance', () => handle.advanceObjective())}>Advance objective</button>
      </div>
      <div className="hbn-controls__group">
        <button onClick={run('save', () => handle.save())} disabled={busy !== null}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button onClick={run('load', () => handle.load())} disabled={busy !== null}>
          {busy === 'load' ? 'Loading…' : 'Load'}
        </button>
      </div>
      <div className="hbn-controls__group">
        <button onClick={() => handle.rotate(-1)}>⟲</button>
        <button onClick={() => handle.rotate(1)}>⟳</button>
        <button onClick={() => handle.zoom(-3)}>Zoom +</button>
        <button onClick={() => handle.zoom(3)}>Zoom −</button>
      </div>
      <div className="hbn-controls__group">
        <label>
          Weather
          <select
            value={weather}
            onChange={(e) => {
              const w = e.target.value as WeatherProfile;
              setWeather(w);
              handle.setWeather(w);
            }}
          >
            {WEATHER_PROFILES.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="hbn-controls__group">
        <button onClick={() => uiStore.getState().openPanel('settings')}>Accessibility</button>
      </div>
      <p className="hbn-controls__hint">WASD move · mouse aim · click fire · Q/E rotate · wheel zoom</p>
    </div>
  );
}
