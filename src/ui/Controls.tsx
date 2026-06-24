// T38 / T18 — the slice's interactive command bar, restyled as a collapsible dev-tools SIDEBAR (left edge)
// so it no longer eats the top of the screen. React owns this shell affordance (V1): every button issues
// validated INTENT to the engine through the EngineHandle (save/load full SaveDelta, structural modify,
// weather), never touching per-frame world state. Pointer-events are enabled here (the HUD stays inert).
// Collapsed/expanded state lives on uiStore (T18, default collapsed) and is read through a primitive
// selector so the snapshot stays cached (B24 — no fresh literals from selectors).

import { useState } from 'react';
import type { EngineHandle } from './GameViewport';
import { WEATHER_PROFILES, type WeatherProfile } from '../config/domains/weather';
import { uiStore } from '../stores/ui';
import { timeOfDayStore } from '../stores/timeOfDay';
import { useUi, useTimeOfDay } from '../stores/react';
import { dayPhaseOf, formatTimeOfDay } from '../render/scene/sky';

const PHASE_LABEL = { dawn: 'Dawn', day: 'Day', dusk: 'Dusk', night: 'Night' } as const;

/** T125 dev group: scrub + freeze the day/night phase for lighting tuning. This is a RENDER-side override
 *  (lighting only) — the deterministic sim clock is untouched (V2/V26). Selectors return primitives (B24). */
function TimeOfDayControls() {
  const current = useTimeOfDay((s) => s.current); // primitive; minute-stepped by the engine
  const overrideEnabled = useTimeOfDay((s) => s.overrideEnabled);
  const override = useTimeOfDay((s) => s.override);
  // The slider drives `override` when frozen; otherwise it tracks (and previews from) the live clock.
  const value = overrideEnabled ? override : current;

  const toggleFreeze = () => {
    const s = timeOfDayStore.getState();
    if (!s.overrideEnabled) s.setOverride(s.current); // capture the live time so the sun doesn't jump on freeze
    s.setOverrideEnabled(!s.overrideEnabled);
  };
  const scrub = (t: number) => {
    const s = timeOfDayStore.getState();
    s.setOverride(t);
    if (!s.overrideEnabled) s.setOverrideEnabled(true); // scrubbing implies freeze-at-this-time
  };

  return (
    <div className="hbn-controls__group" aria-label="time of day">
      <label className="hbn-controls__check">
        <input type="checkbox" checked={overrideEnabled} onChange={toggleFreeze} />
        Freeze time {overrideEnabled ? '(dev)' : ''}
      </label>
      <label>
        Time of day · {formatTimeOfDay(value)} {PHASE_LABEL[dayPhaseOf(value)]}
        <input
          type="range"
          min={0}
          max={1}
          step={1 / 1440}
          value={value}
          onChange={(e) => scrub(Number(e.target.value))}
          aria-label="scrub time of day"
        />
      </label>
    </div>
  );
}

export function Controls({ handle }: { handle: EngineHandle | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherProfile>('clear');
  const collapsed = useUi((s) => s.controlsCollapsed); // primitive bool → cached snapshot (B24-safe).
  if (!handle) return null;

  const run = (label: string, fn: () => void | Promise<void>) => async () => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const toggle = () => uiStore.getState().setControlsCollapsed(!collapsed);

  // Collapsed: only the thin toggle rail is mounted, freeing the rest of the screen edge.
  if (collapsed) {
    return (
      <div className="hbn-controls hbn-controls--collapsed" aria-label="engine controls">
        <button
          className="hbn-controls__toggle"
          onClick={toggle}
          aria-expanded={false}
          aria-label="Open controls"
          title="Open controls"
        >
          ☰
        </button>
      </div>
    );
  }

  return (
    <div className="hbn-controls" aria-label="engine controls">
      <div className="hbn-controls__head">
        <span className="hbn-controls__title">Controls</span>
        <button
          className="hbn-controls__toggle"
          onClick={toggle}
          aria-expanded={true}
          aria-label="Close controls"
          title="Close controls"
        >
          ✕
        </button>
      </div>
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
      <TimeOfDayControls />
      <div className="hbn-controls__group">
        <button onClick={() => uiStore.getState().openPanel('settings')}>Accessibility</button>
      </div>
      <p className="hbn-controls__hint">WASD move · mouse aim · click fire · Q/E rotate · wheel zoom</p>
    </div>
  );
}
