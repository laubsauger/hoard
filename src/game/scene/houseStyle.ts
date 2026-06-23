// T87 — deterministic residential HOUSE variation + states of disarray (V26). A per-house integer seed is
// expanded — through a tiny hash-stream RNG and the typed `world` house config — into ONE concrete HouseStyle
// (footprint-independent look + decay). The same seed always replays the same house, so the district is stable
// across reloads. No magic numbers: every probability/range comes from the resolved config; only the discrete
// material palettes (authored content, like the level geometry) live here as const tables.
//
// The renderer (blockScene) derives a per-building seed from the building's stable footprint, calls
// authorHouseStyle() for the look, and calls the per-element disarray helpers (windowState / roofHoles)
// so window/roof decay is derived deterministically from the SAME seed — keeping the whole house in agreement
// without widening the frozen scene contract (which carries only bounds + storeys).

import { resolveDomain } from '@/config/registry';
import { worldConfig } from '@/config/domains/world';
import type { QualityTier } from '@/config/types';

/** Roof silhouettes a house can take. */
export type RoofShape = 'gable' | 'hip' | 'flat';

/** A window's decay state, derived deterministically from the house seed + window index. */
export type WindowState = 'intact' | 'broken' | 'boarded';

/** The concrete, replay-stable look + decay of one house (V26). All colours are 0xRRGGBB. */
export interface HouseStyle {
  /** The per-house seed this style was authored from (replay key). */
  readonly seed: number;
  readonly storeys: number; // 1 | 2
  /** Clapboard base tint AFTER weathering toward grey by the damage level. */
  readonly wallColor: number;
  /** Original (un-weathered) clapboard tint — used for the protected base skirt read. */
  readonly wallColorClean: number;
  readonly trimColor: number; // window/door frames, eaves, corner boards
  readonly roofColor: number; // shingle tint
  readonly roofShape: RoofShape;
  /** Ridge rise (m) above the wall top (0 for a flat roof). */
  readonly roofPitchMeters: number;
  /** Gable ridge runs along the X axis (else along Z). Irrelevant for hip/flat. */
  readonly ridgeAlongX: boolean;
  readonly hasPorch: boolean;
  readonly hasChimney: boolean;
  /** Overall disarray 0..1 — drives broken windows, roof holes, weathering, debris, collapse. */
  readonly damage: number;
  /** Overgrowth 0..1 — fraction of wall height ivy climbs (0 = none). */
  readonly ivy: number;
  /** True once damage crosses the collapse threshold: a roof sags + a wall section becomes rubble. */
  readonly collapsed: boolean;
}

/** The subset of resolved `world` config house authoring needs (typed; no magic numbers leak in). */
export interface HouseVariationParams {
  readonly twoStoreyChance: number;
  readonly flatRoofChance: number;
  readonly hipRoofChance: number;
  readonly roofPitchMinMeters: number;
  readonly roofPitchMaxMeters: number;
  readonly porchChance: number;
  readonly chimneyChance: number;
  readonly damageMin: number;
  readonly damageMax: number;
  readonly weatherMaxBlend: number;
  readonly windowBoardedFraction: number;
  readonly roofHoleDamageThreshold: number;
  readonly roofHoleMaxCount: number;
  readonly collapseDamageThreshold: number;
  readonly ivyChance: number;
  readonly ivyMaxCoverage: number;
}

/** Resolve the house-variation params from the typed `world` domain for a quality tier (single source). */
export function resolveHouseVariation(tier: QualityTier): HouseVariationParams {
  const w = resolveDomain(worldConfig, tier);
  return {
    twoStoreyChance: w.houseTwoStoreyChance,
    flatRoofChance: w.houseFlatRoofChance,
    hipRoofChance: w.houseHipRoofChance,
    roofPitchMinMeters: w.houseRoofPitchMinMeters,
    roofPitchMaxMeters: w.houseRoofPitchMaxMeters,
    porchChance: w.housePorchChance,
    chimneyChance: w.houseChimneyChance,
    damageMin: w.houseDamageMin,
    damageMax: w.houseDamageMax,
    weatherMaxBlend: w.houseWeatherMaxBlend,
    windowBoardedFraction: w.houseWindowBoardedFraction,
    roofHoleDamageThreshold: w.houseRoofHoleDamageThreshold,
    roofHoleMaxCount: w.houseRoofHoleMaxCount,
    collapseDamageThreshold: w.houseCollapseDamageThreshold,
    ivyChance: w.houseIvyChance,
    ivyMaxCoverage: w.houseIvyMaxCoverage,
  };
}

// ---- authored material palettes (discrete content, not tuning) -------------------------------------
// Faded, desaturated residential clapboard tones (cream / sage / dusty blue / tan / weathered white / muted
// brick) — muted so blood-red + UI-red pop (ART-DIRECTION §4 palette). Roof = asphalt-shingle greys/browns.
// Trim = off-white or near-black for the outline read.
const WALL_PALETTE = [0xc9c0a8, 0xa9b39a, 0x9fb0b6, 0xc2a888, 0xcdc9bd, 0xb08a78, 0x8f9a86, 0xc7b48f] as const;
const ROOF_PALETTE = [0x46423b, 0x564a3c, 0x6a5b48, 0x423f3c, 0x5c5048] as const;
const TRIM_PALETTE = [0xd9d2c2, 0x2b2620, 0xbfae93] as const;
/** Weathered grey the wall tint blends toward as damage rises (peeling/sun-bleached read). */
const WEATHERED_GREY = 0x8d8678;

// ---- deterministic hash-stream RNG -----------------------------------------------------------------
/** A 0..1 hash of (seed, salt) — order-free, so a renderer can pull a specific element's roll by salt. */
export function hash01(seed: number, salt: number): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae3d) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** A sequential 0..1 stream from a seed (each call advances) — for authoring a style in declaration order. */
function rngStream(seed: number): () => number {
  let s = (seed | 0) ^ 0x6d2b79f5;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear blend of two 0xRRGGBB colours (t = 0 → a, 1 → b). */
function mixColor(a: number, b: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const pick = <T>(arr: readonly T[], t: number): T => arr[Math.min(arr.length - 1, Math.floor(t * arr.length))] as T;

/**
 * Author one concrete house look + decay from a per-house seed and the typed variation params (V26). Pure +
 * deterministic — the declaration order of the rng pulls IS the replay contract, so do not reorder.
 */
export function authorHouseStyle(seed: number, p: HouseVariationParams): HouseStyle {
  const rng = rngStream(seed);
  const storeys = rng() < p.twoStoreyChance ? 2 : 1;
  const wallColorClean = pick(WALL_PALETTE, rng());
  const roofColor = pick(ROOF_PALETTE, rng());
  const trimColor = pick(TRIM_PALETTE, rng());

  const roofRoll = rng();
  const roofShape: RoofShape = roofRoll < p.flatRoofChance ? 'flat' : roofRoll < p.flatRoofChance + p.hipRoofChance ? 'hip' : 'gable';
  const roofPitchMeters = roofShape === 'flat' ? 0 : lerp(p.roofPitchMinMeters, p.roofPitchMaxMeters, rng());
  const ridgeAlongX = rng() < 0.5;

  const hasPorch = rng() < p.porchChance;
  const hasChimney = rng() < p.chimneyChance;

  const damage = lerp(p.damageMin, p.damageMax, rng());
  const ivy = rng() < p.ivyChance ? rng() * p.ivyMaxCoverage : 0;

  const wallColor = mixColor(wallColorClean, WEATHERED_GREY, damage * p.weatherMaxBlend);
  const collapsed = damage >= p.collapseDamageThreshold;

  return {
    seed,
    storeys,
    wallColor,
    wallColorClean,
    trimColor,
    roofColor,
    roofShape,
    roofPitchMeters,
    ridgeAlongX,
    hasPorch,
    hasChimney,
    damage,
    ivy,
    collapsed,
  };
}

// ---- per-element disarray helpers (renderer-side, same seed → same result) -------------------------

/**
 * The decay state of the i-th window of a house. Higher damage → more broken windows; of the broken ones a
 * `windowBoardedFraction` are boarded over (rest smashed open). Deterministic in (seed, index).
 */
export function windowState(style: HouseStyle, index: number, boardedFraction: number): WindowState {
  if (hash01(style.seed, 101 + index * 7) >= style.damage) return 'intact';
  return hash01(style.seed, 911 + index * 13) < boardedFraction ? 'boarded' : 'broken';
}

/** A roof hole (missing-shingle / caved-in patch), centred at fractional `t` along the ridge with a radius. */
export interface RoofHole {
  /** Position along the ridge, 0..1. */
  readonly t: number;
  /** Hole radius in metres. */
  readonly radiusMeters: number;
}

/**
 * Deterministic roof holes for a house. None below the damage threshold; up to `maxCount` on a ruined roof,
 * scaling with how far past the threshold the damage sits. Each hole's position + size is hashed from the seed.
 */
export function roofHoles(style: HouseStyle, threshold: number, maxCount: number): RoofHole[] {
  if (style.damage < threshold || maxCount <= 0) return [];
  const span = Math.max(1e-3, 1 - threshold);
  const intensity = Math.min(1, (style.damage - threshold) / span);
  const count = Math.max(1, Math.round(intensity * maxCount));
  const holes: RoofHole[] = [];
  for (let i = 0; i < count; i++) {
    const t = 0.15 + 0.7 * hash01(style.seed, 401 + i * 17);
    const radiusMeters = 0.5 + 1.1 * hash01(style.seed, 733 + i * 19) * intensity;
    holes.push({ t, radiusMeters });
  }
  return holes;
}
