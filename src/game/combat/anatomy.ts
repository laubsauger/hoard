// T41 / V16 / V17 — anatomical region helpers (forward-pulled subset of T16/T17).
// Maps the frozen `AnatomyRegion` union to a sever bit (for the SoA `anatomyFlags` u32 bitfield)
// and to a damage class (head/torso/limb) so the firearm hit path can resolve region damage
// without any literals. Full segmentation + wound caps + detached-part assets land in T17.

import type { AnatomyRegion } from '@/game/core/contracts';

/** Stable bit index per region within the u32 `anatomyFlags` field. Order is part of this module. */
export const ANATOMY_REGIONS: readonly AnatomyRegion[] = [
  'head', 'neck', 'torsoUpper', 'torsoLower', 'armLeft', 'armRight', 'legLeft', 'legRight',
];

const REGION_BIT: Readonly<Record<AnatomyRegion, number>> = {
  head: 1 << 0,
  neck: 1 << 1,
  torsoUpper: 1 << 2,
  torsoLower: 1 << 3,
  armLeft: 1 << 4,
  armRight: 1 << 5,
  legLeft: 1 << 6,
  legRight: 1 << 7,
};

/** Single-region sever bit for the anatomyFlags bitfield. */
export function regionBit(region: AnatomyRegion): number {
  return REGION_BIT[region];
}

export function isSevered(anatomyFlags: number, region: AnatomyRegion): boolean {
  return (anatomyFlags & REGION_BIT[region]) !== 0;
}

/** Head + neck destruction is the fatal class (V17 head-kill rule). */
export function isFatalRegion(region: AnatomyRegion): boolean {
  return region === 'head' || region === 'neck';
}

/** Torso regions are not severable in ordinary combat (V17 — modular segments are limbs/head). */
export function isSeverable(region: AnatomyRegion): boolean {
  return region !== 'torsoUpper' && region !== 'torsoLower';
}

export type DamageClass = 'head' | 'torso' | 'limb';

export function damageClass(region: AnatomyRegion): DamageClass {
  if (region === 'head' || region === 'neck') return 'head';
  if (region === 'torsoUpper' || region === 'torsoLower') return 'torso';
  return 'limb';
}
