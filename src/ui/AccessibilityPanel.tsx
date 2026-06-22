// T40 / V29 — accessibility settings panel. React owns this shell affordance (V1). Every control writes a
// single persisted setting in the settings store; the running engine subscribes to that store and applies
// the change live (GameViewport -> BlockScene.setAccessibility + the render systems that take these params).
// Plain inputs only — no new dependency (the project ships no component library). The panel itself honours
// high-contrast + UI-scale so the accessibility surface is dogfooded.

import { useSettings, useUi } from '../stores/react';
import { settingsStore } from '../stores/settings';

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="hbn-a11y__row">
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
      <span className="hbn-a11y__val">{Math.round(value * 100)}%</span>
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

export function AccessibilityPanel() {
  const open = useUi((s) => s.activePanel === 'settings');
  const closePanel = useUi((s) => s.closePanel);

  // V11: subscribe to the individual primitives this panel edits.
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

  // Setters are stable references on the store — read them directly so the panel never subscribes to the
  // whole state (V11). Editing one setting re-renders only the rows whose primitive selectors changed.
  const set = settingsStore.getState();

  if (!open) return null;

  return (
    <div
      className={`hbn-a11y${highContrastText ? ' hbn-a11y--contrast' : ''}`}
      style={{ fontSize: `${uiScale}em` }}
      role="dialog"
      aria-label="accessibility settings"
    >
      <header className="hbn-a11y__head">
        <h2>Accessibility</h2>
        <button onClick={() => closePanel()} aria-label="close accessibility settings">×</button>
      </header>
      <Slider label="Outline strength" value={outlineStrength} onChange={set.setOutlineStrength} />
      <Slider label="Target highlight" value={targetHighlightStrength} onChange={set.setTargetHighlightStrength} />
      <Slider label="Gore intensity" value={goreIntensity} onChange={set.setGoreIntensity} />
      <Slider label="Camera shake" value={cameraShakeScale} onChange={set.setCameraShakeScale} />
      <Toggle label="Reduce flashes" value={reduceFlashes} onChange={set.setReduceFlashes} />
      <Toggle label="Reduce motion" value={motionReduction} onChange={set.setMotionReduction} />
      <Toggle label="High-contrast text" value={highContrastText} onChange={set.setHighContrastText} />
      <label className="hbn-a11y__row">
        <span>UI scale</span>
        <input
          type="range"
          min={0.75}
          max={2}
          step={0.05}
          value={uiScale}
          onChange={(e) => set.setUiScale(Number(e.target.value))}
          aria-label="UI scale"
        />
        <span className="hbn-a11y__val">{Math.round(uiScale * 100)}%</span>
      </label>
      <Toggle label="Color-independent indicators" value={colorIndependentIndicators} onChange={set.setColorIndependentIndicators} />
      <Toggle label="Audio-cue visual indicators" value={audioCueIndicators} onChange={set.setAudioCueIndicators} />
      <Toggle label="Subtitles" value={subtitles} onChange={set.setSubtitles} />
      <Toggle label="Pause/slow for complex actions" value={pauseForComplexActions} onChange={set.setPauseForComplexActions} />
    </div>
  );
}
