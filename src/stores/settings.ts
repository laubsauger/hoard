// T4 / T40 / V11 / V25 / V29 — settings store. PERSISTED. Holds user-overridable settings only.
// Quality-tier override is stored but a safe-limit guard lives in the engine (applyTierOverride).
// The full V29 accessibility surface lives here; DEFAULTS are seeded from the typed accessibility config
// domain (V4 — no magic numbers), and the live values are what the render/UI systems consume.

import { createStore } from 'zustand/vanilla';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import { persistStorage, PERSIST_PREFIX } from './storage';
import { resolveDomain } from '../config/registry';
import { accessibilityConfig } from '../config/domains/accessibility';
import { QUALITY_TIERS, type QualityTier } from '../config/types';

// V29 defaults come from typed config (reference tier — these are user-facing defaults, not tier-scaled).
const A11Y = resolveDomain(accessibilityConfig, 'desktop-high');

export interface SettingsState {
  readonly qualityTierOverride: QualityTier | null;
  readonly masterVolume: number; // 0..1
  // ---- V29 accessibility ----
  readonly goreIntensity: number; // 0..1
  readonly outlineStrength: number; // 0..1
  readonly targetHighlightStrength: number; // 0..1
  readonly cameraShakeScale: number; // 0..1
  readonly reduceFlashes: boolean; // photosensitivity
  readonly motionReduction: boolean;
  readonly highContrastText: boolean;
  readonly uiScale: number; // scalable UI
  readonly colorIndependentIndicators: boolean;
  readonly audioCueIndicators: boolean; // visual indicators for alarms/glass/directional threats
  readonly subtitles: boolean;
  readonly pauseForComplexActions: boolean; // optional pause/slowdown for inventory + complex actions
  setQualityTierOverride(tier: QualityTier | null): void;
  setMasterVolume(v: number): void;
  setGoreIntensity(v: number): void;
  setOutlineStrength(v: number): void;
  setTargetHighlightStrength(v: number): void;
  setCameraShakeScale(v: number): void;
  setReduceFlashes(v: boolean): void;
  setMotionReduction(v: boolean): void;
  setHighContrastText(v: boolean): void;
  setUiScale(v: number): void;
  setColorIndependentIndicators(v: boolean): void;
  setAudioCueIndicators(v: boolean): void;
  setSubtitles(v: boolean): void;
  setPauseForComplexActions(v: boolean): void;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) throw new Error(`expected finite number, got ${v}`);
  return Math.min(1, Math.max(0, v));
}

export function createSettingsStore() {
  return createStore<SettingsState>()(
    subscribeWithSelector(
      persist(
        (set) => ({
          qualityTierOverride: null,
          masterVolume: 0.8,
          goreIntensity: A11Y.goreIntensityDefault,
          outlineStrength: A11Y.outlineStrengthDefault,
          targetHighlightStrength: A11Y.targetHighlightStrengthDefault,
          cameraShakeScale: A11Y.cameraShakeScaleDefault,
          reduceFlashes: A11Y.reduceFlashesDefault,
          motionReduction: A11Y.reduceMotionDefault,
          highContrastText: A11Y.highContrastDefault,
          uiScale: A11Y.uiScaleDefault,
          colorIndependentIndicators: A11Y.colorIndependentIndicatorsDefault,
          audioCueIndicators: A11Y.audioCueIndicatorsDefault,
          subtitles: A11Y.subtitlesDefault,
          pauseForComplexActions: A11Y.pauseForComplexActionsDefault,
          // V25 — the store only accepts a KNOWN tier or null (auto). The hardware safe-limit guard that
          // forbids requesting a MORE-demanding tier than the device supports lives in render/quality
          // (evaluateTierOverride/applyTierOverride) and is applied when the engine resolves the tier.
          setQualityTierOverride: (qualityTierOverride) => {
            if (qualityTierOverride !== null && !QUALITY_TIERS.includes(qualityTierOverride)) {
              throw new Error(`unknown quality tier override: ${String(qualityTierOverride)}`);
            }
            set({ qualityTierOverride });
          },
          setMasterVolume: (v) => set({ masterVolume: clamp01(v) }),
          setGoreIntensity: (v) => set({ goreIntensity: clamp01(v) }),
          setOutlineStrength: (v) => set({ outlineStrength: clamp01(v) }),
          setTargetHighlightStrength: (v) => set({ targetHighlightStrength: clamp01(v) }),
          setCameraShakeScale: (v) => set({ cameraShakeScale: clamp01(v) }),
          setReduceFlashes: (reduceFlashes) => set({ reduceFlashes }),
          setMotionReduction: (motionReduction) => set({ motionReduction }),
          setHighContrastText: (highContrastText) => set({ highContrastText }),
          setUiScale: (v) => {
            if (!Number.isFinite(v) || v <= 0) throw new Error(`uiScale must be a positive number, got ${v}`);
            set({ uiScale: v });
          },
          setColorIndependentIndicators: (colorIndependentIndicators) => set({ colorIndependentIndicators }),
          setAudioCueIndicators: (audioCueIndicators) => set({ audioCueIndicators }),
          setSubtitles: (subtitles) => set({ subtitles }),
          setPauseForComplexActions: (pauseForComplexActions) => set({ pauseForComplexActions }),
        }),
        {
          name: `${PERSIST_PREFIX}:settings`,
          version: 2,
          storage: persistStorage(),
        },
      ),
    ),
  );
}

export const settingsStore = createSettingsStore();
export type SettingsStore = typeof settingsStore;
