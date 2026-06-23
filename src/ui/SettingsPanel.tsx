// T50 / T51 / V25 / V29 — the settings panel, reachable from the pause menu (and the command bar). One
// dialog over the persisted settings + input stores (V11). React owns this shell affordance (V1); every
// control writes a single store primitive and the running engine subscribes to apply changes live
// (GameViewport -> BlockScene.setAccessibility; the tier override is read when the engine resolves its
// tier). Plain inputs + CSS only — the project ships NO component library. The panel honours high-contrast
// + UI-scale so the accessibility surface is dogfooded.
//
// Sections:
//   • Graphics    — quality-tier override (Auto + the V25 tiers; safe-limit guard clamps at engine start).
//   • Audio       — Master / Sound (SFX) / Music volume buses.
//   • Controls    — V29 rebindable keymap (click-to-capture) + pointer/zoom sensitivity + invert.
//   • Accessibility — the full V29 surface (outline/highlight/gore/shake/flashes/motion/contrast/scale/…).

import { useEffect, useState } from 'react';
import { useSettings, useInput, useUi } from '../stores/react';
import { settingsStore } from '../stores/settings';
import {
  inputStore,
  formatKeyCode,
  INPUT_ACTIONS,
  INPUT_ACTION_LABELS,
  type InputAction,
} from '../stores/input';
import { QUALITY_TIERS, type QualityTier } from '../config/types';
import { inputConfig } from '../config/domains/input';

// Slider granularity is presentation only (not gameplay config) — named so there are no inline magics.
const NORM_MIN = 0;
const NORM_MAX = 1;
const NORM_STEP = 0.05;
const UI_SCALE_MIN = 0.75;
const UI_SCALE_MAX = 2;
const SENS_STEP = 0.1;

const TIER_AUTO = 'auto';
const TIER_LABELS: Readonly<Record<QualityTier, string>> = {
  'desktop-high': 'Desktop — High',
  'desktop-medium': 'Desktop — Medium',
  'desktop-compat': 'Desktop — Compatibility',
  'mobile-webgpu': 'Mobile (WebGPU)',
};

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="hbn-a11y__row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
      <span className="hbn-a11y__val">{format ? format(value) : `${Math.round(value * 100)}%`}</span>
    </label>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="hbn-a11y__row">
      <span>{label}</span>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
    </label>
  );
}

/** V29 — rebindable keymap with click-to-capture. The capture listener runs in the CAPTURE phase so the
 *  pressed key rebinds without also firing the game's own key handlers; Escape cancels the capture. */
function ControlsSection() {
  const bindings = useInput((s) => s.bindings);
  const pointerSensitivity = useInput((s) => s.pointerSensitivity);
  const zoomSensitivity = useInput((s) => s.zoomSensitivity);
  const invertZoom = useInput((s) => s.invertZoom);
  const [capturing, setCapturing] = useState<InputAction | null>(null);
  const input = inputStore.getState();

  useEffect(() => {
    if (capturing === null) return;
    const finish = (code: string) => {
      if (code !== 'Escape') inputStore.getState().rebind(capturing, code);
      setCapturing(null);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      finish(e.code);
    };
    const onMouse = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      finish(`Mouse${e.button}`);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
    };
  }, [capturing]);

  return (
    <>
      <h3 className="hbn-a11y__section">Controls</h3>
      {INPUT_ACTIONS.map((action) => (
        <div className="hbn-a11y__row" key={action}>
          <span>{INPUT_ACTION_LABELS[action]}</span>
          <button
            type="button"
            className={`hbn-keybind${capturing === action ? ' is-capturing' : ''}`}
            onClick={() => setCapturing(action)}
            aria-label={`rebind ${INPUT_ACTION_LABELS[action]}`}
          >
            {capturing === action ? 'press a key…' : formatKeyCode(bindings[action])}
          </button>
        </div>
      ))}
      <Slider
        label="Pointer sensitivity"
        value={pointerSensitivity}
        min={inputConfig.pointerSensitivity.min}
        max={inputConfig.pointerSensitivity.max}
        step={SENS_STEP}
        onChange={input.setPointerSensitivity}
        format={(v) => `${v.toFixed(1)}×`}
      />
      <Slider
        label="Zoom sensitivity"
        value={zoomSensitivity}
        min={inputConfig.zoomSensitivity.min}
        max={inputConfig.zoomSensitivity.max}
        step={SENS_STEP}
        onChange={input.setZoomSensitivity}
        format={(v) => `${v.toFixed(1)}×`}
      />
      <Toggle label="Invert zoom" value={invertZoom} onChange={input.setInvertZoom} />
      <div className="hbn-a11y__row">
        <span>Restore default keys</span>
        <button type="button" className="hbn-keybind" onClick={() => input.resetBindings()}>
          Reset
        </button>
      </div>
    </>
  );
}

export function SettingsPanel() {
  const open = useUi((s) => s.activePanel === 'settings');
  const closePanel = useUi((s) => s.closePanel);

  // V11 — subscribe to the individual primitives this panel edits (one row re-renders per change).
  const qualityTierOverride = useSettings((s) => s.qualityTierOverride);
  const masterVolume = useSettings((s) => s.masterVolume);
  const sfxVolume = useSettings((s) => s.sfxVolume);
  const musicVolume = useSettings((s) => s.musicVolume);
  const goreIntensity = useSettings((s) => s.goreIntensity);
  const outlineStrength = useSettings((s) => s.outlineStrength);
  const targetHighlightStrength = useSettings((s) => s.targetHighlightStrength);
  const cameraShakeScale = useSettings((s) => s.cameraShakeScale);
  const reduceFlashes = useSettings((s) => s.reduceFlashes);
  const motionReduction = useSettings((s) => s.motionReduction);
  const highContrastText = useSettings((s) => s.highContrastText);
  const uiScale = useSettings((s) => s.uiScale);
  const colorIndependentIndicators = useSettings((s) => s.colorIndependentIndicators);
  const audioCueIndicators = useSettings((s) => s.audioCueIndicators);
  const subtitles = useSettings((s) => s.subtitles);
  const pauseForComplexActions = useSettings((s) => s.pauseForComplexActions);

  // Setters are stable references on the store — read them directly (never subscribe to whole state, V11).
  const set = settingsStore.getState();

  if (!open) return null;

  return (
    <div
      className={`hbn-a11y${highContrastText ? ' hbn-a11y--contrast' : ''}`}
      style={{ fontSize: `${uiScale}em` }}
      role="dialog"
      aria-label="settings"
    >
      <header className="hbn-a11y__head">
        <h2>Settings</h2>
        <button onClick={() => closePanel()} aria-label="close settings">
          ×
        </button>
      </header>

      <h3 className="hbn-a11y__section">Graphics</h3>
      <label className="hbn-a11y__row">
        <span>Quality tier</span>
        <select
          value={qualityTierOverride ?? TIER_AUTO}
          onChange={(e) => set.setQualityTierOverride(e.target.value === TIER_AUTO ? null : (e.target.value as QualityTier))}
          aria-label="quality tier override"
        >
          <option value={TIER_AUTO}>Auto (detected)</option>
          {QUALITY_TIERS.map((t) => (
            <option key={t} value={t}>
              {TIER_LABELS[t]}
            </option>
          ))}
        </select>
      </label>

      <h3 className="hbn-a11y__section">Audio</h3>
      <Slider label="Master" value={masterVolume} min={NORM_MIN} max={NORM_MAX} step={NORM_STEP} onChange={set.setMasterVolume} />
      <Slider label="Sound" value={sfxVolume} min={NORM_MIN} max={NORM_MAX} step={NORM_STEP} onChange={set.setSfxVolume} />
      <Slider label="Music" value={musicVolume} min={NORM_MIN} max={NORM_MAX} step={NORM_STEP} onChange={set.setMusicVolume} />

      <ControlsSection />

      <h3 className="hbn-a11y__section">Accessibility</h3>
      <Slider label="Outline strength" value={outlineStrength} min={NORM_MIN} max={NORM_MAX} step={NORM_STEP} onChange={set.setOutlineStrength} />
      <Slider label="Target highlight" value={targetHighlightStrength} min={NORM_MIN} max={NORM_MAX} step={NORM_STEP} onChange={set.setTargetHighlightStrength} />
      <Slider label="Gore intensity" value={goreIntensity} min={NORM_MIN} max={NORM_MAX} step={NORM_STEP} onChange={set.setGoreIntensity} />
      <Slider label="Camera shake" value={cameraShakeScale} min={NORM_MIN} max={NORM_MAX} step={NORM_STEP} onChange={set.setCameraShakeScale} />
      <Toggle label="Reduce flashes" value={reduceFlashes} onChange={set.setReduceFlashes} />
      <Toggle label="Reduce motion" value={motionReduction} onChange={set.setMotionReduction} />
      <Toggle label="High-contrast text" value={highContrastText} onChange={set.setHighContrastText} />
      <Slider
        label="UI scale"
        value={uiScale}
        min={UI_SCALE_MIN}
        max={UI_SCALE_MAX}
        step={NORM_STEP}
        onChange={set.setUiScale}
      />
      <Toggle label="Color-independent indicators" value={colorIndependentIndicators} onChange={set.setColorIndependentIndicators} />
      <Toggle label="Audio-cue visual indicators" value={audioCueIndicators} onChange={set.setAudioCueIndicators} />
      <Toggle label="Subtitles" value={subtitles} onChange={set.setSubtitles} />
      <Toggle label="Pause/slow for complex actions" value={pauseForComplexActions} onChange={set.setPauseForComplexActions} />
    </div>
  );
}
