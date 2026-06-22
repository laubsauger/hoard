// T4 / V11 / V25 / V29 — settings store. PERSISTED. Holds user-overridable settings only.
// Quality-tier override is stored but a safe-limit guard lives in the engine (applyTierOverride).

import { createStore } from 'zustand/vanilla';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import { persistStorage, PERSIST_PREFIX } from './storage';
import type { QualityTier } from '../config/types';

export interface SettingsState {
  readonly qualityTierOverride: QualityTier | null;
  readonly masterVolume: number; // 0..1
  readonly goreIntensity: number; // 0..1 (V29)
  readonly outlineStrength: number; // 0..1 (V29)
  readonly motionReduction: boolean; // V29
  readonly highContrastText: boolean; // V29
  readonly uiScale: number; // V29 scalable UI
  setQualityTierOverride(tier: QualityTier | null): void;
  setMasterVolume(v: number): void;
  setGoreIntensity(v: number): void;
  setOutlineStrength(v: number): void;
  setMotionReduction(v: boolean): void;
  setHighContrastText(v: boolean): void;
  setUiScale(v: number): void;
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
          goreIntensity: 1,
          outlineStrength: 1,
          motionReduction: false,
          highContrastText: false,
          uiScale: 1,
          setQualityTierOverride: (qualityTierOverride) => set({ qualityTierOverride }),
          setMasterVolume: (v) => set({ masterVolume: clamp01(v) }),
          setGoreIntensity: (v) => set({ goreIntensity: clamp01(v) }),
          setOutlineStrength: (v) => set({ outlineStrength: clamp01(v) }),
          setMotionReduction: (motionReduction) => set({ motionReduction }),
          setHighContrastText: (highContrastText) => set({ highContrastText }),
          setUiScale: (v) => {
            if (!Number.isFinite(v) || v <= 0) throw new Error(`uiScale must be a positive number, got ${v}`);
            set({ uiScale: v });
          },
        }),
        {
          name: `${PERSIST_PREFIX}:settings`,
          version: 1,
          storage: persistStorage(),
        },
      ),
    ),
  );
}

export const settingsStore = createSettingsStore();
export type SettingsStore = typeof settingsStore;
