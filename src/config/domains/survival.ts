// Config domain: survival. Owned by lane S (T22). V31 — slow pressure, not meter babysitting.
// All rates are per IN-GAME SECOND (unit 'ratio' = fraction of a 0..1 need accrued/lost per second);
// the survival system multiplies by elapsed seconds. Defaults are deliberately TINY so needs build
// over many minutes/hours of play, never as constant babysitting. Sleep quality weights + competence
// reductions are also typed here so no survival math hides a magic number (V4).

import { num } from '../spec';
import { registerDomain } from '../registry';

export const survivalConfig = registerDomain('survival', {
  hungerRatePerSec: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Hunger need (0..1) accrued per in-game second (~18h to full). Slow pressure (V31).',
    default: 0.000015, min: 0, max: 0.05,
  }),
  thirstRatePerSec: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Thirst need (0..1) accrued per in-game second (~10h to full). Faster than hunger.',
    default: 0.000028, min: 0, max: 0.05,
  }),
  fatigueRatePerSec: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Fatigue (0..1) accrued per awake in-game second (~15h to full).',
    default: 0.000018, min: 0, max: 0.05,
  }),
  starvationHealthLossPerSec: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Health (0..1) lost per second once hunger is maxed (1).',
    default: 0.002, min: 0, max: 0.1,
  }),
  dehydrationHealthLossPerSec: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Health (0..1) lost per second once thirst is maxed (1).',
    default: 0.003, min: 0, max: 0.1,
  }),
  bleedHealthLossPerSec: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Health (0..1) lost per second per unit of bleeding severity.',
    default: 0.01, min: 0, max: 0.2,
  }),
  bleedClotPerSec: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Bleeding severity (0..1) that self-resolves (clots) per second untreated.',
    default: 0.002, min: 0, max: 0.2,
  }),
  painFromBleed: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Pain (0..1) contributed per unit of bleeding severity (steady-state coupling).',
    default: 0.5, min: 0, max: 1,
  }),
  painDecayPerSec: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Pain (0..1) that fades per second toward its bleed-driven floor.',
    default: 0.01, min: 0, max: 0.5,
  }),
  infectionRiskPerSec: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Infection progress (0..1) accrued per second per untreated open wound.',
    default: 0.0005, min: 0, max: 0.05,
  }),
  infectionSymptomThreshold: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Infection level (0..1) above which symptoms surface (fever -> pain + fatigue).',
    default: 0.4, min: 0, max: 1,
  }),
  infectionSymptomPain: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Extra pain (0..1) per second once infection symptoms are showing.',
    default: 0.004, min: 0, max: 0.2,
  }),
  stressFromThreatPerSec: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Stress (0..1) accrued per second per unit of perceived threat intensity.',
    default: 0.02, min: 0, max: 0.5,
  }),
  stressFromPain: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Stress (0..1) accrued per second per unit of pain.',
    default: 0.005, min: 0, max: 0.5,
  }),
  stressDecayPerSec: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Stress (0..1) that fades per second in safety (no threat).',
    default: 0.008, min: 0, max: 0.5,
  }),
  panicStressThreshold: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Stress (0..1) above which panic is flagged (degrades control/awareness, never agency — V31).',
    default: 0.75, min: 0, max: 1,
  }),
  // ---- stamina / sprint (escape lever: outrun the horde, but it costs stamina, tied to fatigue) ----
  staminaDrainPerSec: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Stamina (0..1) drained per second while sprinting (~2.9s from full to empty at default).',
    default: 0.35, min: 0, max: 5,
  }),
  staminaRegenPerSec: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Stamina (0..1) regenerated per second while not sprinting (before the fatigue slowdown).',
    default: 0.15, min: 0, max: 5,
  }),
  sprintMinStamina: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Hysteresis: once stamina bottoms out, sprint stays disabled until it recovers above this.',
    default: 0.2, min: 0.01, max: 1,
  }),
  staminaFatigueCapCoupling: num({
    owner: 'survival', unit: 'ratio',
    doc: 'How much fatigue (0..1) lowers max stamina: maxStamina = 1 - fatigue * this (exhausted = little).',
    default: 0.6, min: 0, max: 1,
  }),
  staminaFatigueRegenCoupling: num({
    owner: 'survival', unit: 'ratio',
    doc: 'How much fatigue (0..1) slows stamina regen: regen *= 1 - fatigue * this.',
    default: 0.5, min: 0, max: 1,
  }),
  // ---- sleep quality (V31: quality depends on security, pain, noise, temperature) ----
  sleepRecoveryPerHour: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Fatigue (0..1) recovered per in-game hour of perfect-quality sleep.',
    default: 0.18, min: 0, max: 1,
  }),
  sleepSecurityWeight: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Multiplicative weight of security on sleep quality.',
    default: 1, min: 0, max: 1,
  }),
  sleepPainWeight: num({
    owner: 'survival', unit: 'ratio',
    doc: 'How strongly pain subtracts from sleep quality.',
    default: 0.6, min: 0, max: 1,
  }),
  sleepNoiseWeight: num({
    owner: 'survival', unit: 'ratio',
    doc: 'How strongly ambient noise subtracts from sleep quality.',
    default: 0.5, min: 0, max: 1,
  }),
  sleepTempWeight: num({
    owner: 'survival', unit: 'ratio',
    doc: 'How strongly temperature discomfort subtracts from sleep quality.',
    default: 0.4, min: 0, max: 1,
  }),
  // ---- competence progression (V31: more reliability, not superhuman damage) ----
  competenceDecayReductionMax: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Max fraction by which full competence (1) reduces hunger/thirst/fatigue rates.',
    default: 0.35, min: 0, max: 0.9,
  }),
  competenceSleepQualityBonusMax: num({
    owner: 'survival', unit: 'ratio',
    doc: 'Max sleep-quality bonus fraction granted by full competence (settling in faster).',
    default: 0.25, min: 0, max: 0.9,
  }),
});
