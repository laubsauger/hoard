// LightingSystem: the interior exposure transition is monotonic (eyes adapting, not a snap) and lifts exposure
// while indoors; a darker scene gets the night-floor boost. Pure CPU — real Three lights + a fake runtime whose
// scene exposes building bounds (for the isInside test) and a constant clock.

import { describe, it, expect } from 'vitest';
import { AmbientLight, Color, DirectionalLight, Fog, HemisphereLight, Scene } from 'three';
import { LightingSystem, type LightingHandles, type LightingSystemConfig } from './lightingSystem';
import type { GameRuntime } from '../../../game/runtime';
import { resolveDomain } from '../../../config/registry';
import { weatherConfig, weatherGrade, WEATHER_PROFILES, type WeatherGrade, type WeatherProfile } from '../../../config/domains/weather';

const W = resolveDomain(weatherConfig, 'desktop-high');
const GRADES = WEATHER_PROFILES.reduce(
  (acc, p) => { acc[p] = weatherGrade(W, p); return acc; },
  {} as Record<WeatherProfile, WeatherGrade>,
);

const CFG: LightingSystemConfig = {
  tier: 'desktop-high',
  navCellSize: 1,
  shadowLightDistanceMeters: 100,
  baseExposure: 1,
  exposureTransitionSeconds: 1,
  sunIntensity: 3,
  moonIntensity: 0.3,
  ambientIntensity: 0.5,
  minAmbientIntensity: 0.1,
  fogDistanceSmoothingPerSecond: 2,
  fogFloorLuminance: 0.1,
  nightExposureBoostStops: 2,
  weather: { sunElevationMaxDegrees: 60, moonElevationMaxDegrees: 40, sunAzimuthDegrees: 45 },
  weatherGrades: GRADES,
  gradeSmoothingPerSecond: 4,
  fogNightColorScale: 0.32,
  moonColor: 0xaebed8,
};

function makeHandles(): LightingHandles {
  const scene = new Scene();
  scene.background = new Color(0x000000); // lighting copies the fog colour onto an EXISTING Color
  return { scene, sun: new DirectionalLight(), ambient: new AmbientLight(), hemi: new HemisphereLight(), fog: new Fog(0x000000, 1, 400) };
}

// inside: a building footprint covering cell (5,5); outside: bounds far away so the player cell misses.
function fakeRuntime(inside: boolean, timeOfDay: number, weather: WeatherProfile = 'clear'): GameRuntime {
  const bounds = inside ? { minCx: 0, maxCx: 10, minCy: 0, maxCy: 10 } : { minCx: 100, maxCx: 110, minCy: 100, maxCy: 110 };
  const severity = weather === 'clear' ? W.severityClear : weather === 'rain' ? W.severityRain : weather === 'fog' ? W.severityFog : W.severitySmoke;
  return {
    player: () => ({ x: 5, y: 0, z: 5 }),
    playerAim: () => 0,
    weather,
    weatherSeverity: severity,
    timeOfDay: () => timeOfDay,
    scene: { buildings: [{ bounds }] },
  } as unknown as GameRuntime;
}

describe('LightingSystem', () => {
  it('raises exposure monotonically as the player settles indoors at night (no snap)', () => {
    const sys = new LightingSystem(makeHandles(), CFG);
    const rt = fakeRuntime(true, 0.0); // midnight, indoors — the interior boost applies here (B44 daylight-faded)
    let prev = -Infinity;
    const series: number[] = [];
    for (let i = 0; i < 20; i++) {
      const { exposure } = sys.update(1 / 30, rt);
      expect(exposure).toBeGreaterThanOrEqual(prev - 1e-9); // monotonic non-decreasing
      prev = exposure;
      series.push(exposure);
    }
    // it actually moved (a transition, not a static value) and converged.
    expect(series[series.length - 1]!).toBeGreaterThan(series[0]!);
    expect(sys.currentExposure).toBe(series[series.length - 1]);
  });

  it('lifts indoor exposure above the matched outdoor exposure AT NIGHT (interior compensation)', () => {
    const inside = new LightingSystem(makeHandles(), CFG);
    const outside = new LightingSystem(makeHandles(), CFG);
    for (let i = 0; i < 40; i++) {
      inside.update(1 / 30, fakeRuntime(true, 0.0));
      outside.update(1 / 30, fakeRuntime(false, 0.0));
    }
    expect(inside.currentExposure).toBeGreaterThan(outside.currentExposure);
  });

  it('B44: fades the interior boost in DAYLIGHT so stepping outside does NOT drop exposure (no sudden darkening)', () => {
    const inside = new LightingSystem(makeHandles(), CFG);
    const outside = new LightingSystem(makeHandles(), CFG);
    for (let i = 0; i < 60; i++) {
      inside.update(1 / 30, fakeRuntime(true, 0.5)); // noon, indoors
      outside.update(1 / 30, fakeRuntime(false, 0.5)); // noon, outdoors
    }
    // With interiorExposureDaylightFalloff=1 the daylight interior boost is gone — indoor exposure must NOT
    // exceed the outdoor exposure (the bug was indoor >> outdoor → leaving read much darker).
    expect(inside.currentExposure).toBeCloseTo(outside.currentExposure, 6);
  });

  it('applies the night-floor boost so a dark scene is brighter than a bright one (exterior)', () => {
    const night = new LightingSystem(makeHandles(), CFG);
    const day = new LightingSystem(makeHandles(), CFG);
    for (let i = 0; i < 5; i++) {
      night.update(1 / 30, fakeRuntime(false, 0.0)); // midnight
      day.update(1 / 30, fakeRuntime(false, 0.5)); // noon
    }
    expect(night.currentExposure).toBeGreaterThan(day.currentExposure);
  });

  it('T126: a timeOfDay override drives the lighting instead of the sim clock (render-side phase override)', () => {
    const sys = new LightingSystem(makeHandles(), CFG);
    // Sim clock says noon, but override to midnight — the result must report midnight and read as a darker (higher
    // exposure) night scene, proving the lighting used the override, not runtime.timeOfDay().
    const noonRt = fakeRuntime(false, 0.5);
    let res = sys.update(1 / 30, noonRt, 0.0);
    for (let i = 0; i < 5; i++) res = sys.update(1 / 30, noonRt, 0.0);
    expect(res.timeOfDay).toBe(0.0);
    const dayExposure = new LightingSystem(makeHandles(), CFG).update(1 / 30, fakeRuntime(false, 0.5)).exposure;
    expect(res.exposure).toBeGreaterThan(dayExposure);
    // Null/undefined override falls through to the sim clock.
    expect(sys.update(1 / 30, noonRt).timeOfDay).toBe(0.5);
  });

  // Settle a system at noon under a weather profile and read its fog + light state.
  function settle(weather: WeatherProfile) {
    const h = makeHandles();
    const sys = new LightingSystem(h, CFG);
    for (let i = 0; i < 240; i++) sys.update(1 / 30, fakeRuntime(false, 0.5, weather), 0.5);
    return { fogFar: h.fog.far, fogColor: h.fog.color.clone(), sun: h.sun.intensity, ambient: h.ambient.intensity, sunColor: h.sun.color.clone() };
  }

  it('grades fog DISTANCE per weather: fog has the shortest far, clear the longest', () => {
    const clear = settle('clear');
    const rain = settle('rain');
    const fog = settle('fog');
    const smoke = settle('smoke');
    expect(fog.fogFar).toBeLessThan(rain.fogFar);
    expect(fog.fogFar).toBeLessThan(smoke.fogFar);
    expect(fog.fogFar).toBeLessThan(clear.fogFar);
    expect(clear.fogFar).toBeGreaterThan(rain.fogFar); // clear is the crispest (furthest fog)
  });

  it('resolves a DISTINCT fog/atmosphere colour for each weather profile', () => {
    const colours = (['clear', 'rain', 'fog', 'smoke'] as const).map((p) => settle(p).fogColor);
    for (let i = 0; i < colours.length; i++) {
      for (let j = i + 1; j < colours.length; j++) {
        const a = colours[i]!, b = colours[j]!;
        const delta = Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
        expect(delta).toBeGreaterThan(0.05); // visibly different hue/brightness
      }
    }
    // Smoke skews warm (red > blue); fog is near-neutral/cool (blue >= red, bright).
    const smoke = settle('smoke').fogColor;
    expect(smoke.r).toBeGreaterThan(smoke.b);
    const fogC = settle('fog').fogColor;
    expect(fogC.b).toBeGreaterThanOrEqual(fogC.r - 1e-3);
  });

  it('grades the key + ambient per weather: clear has the strongest key, fog the highest ambient', () => {
    const clear = settle('clear');
    const rain = settle('rain');
    const fog = settle('fog');
    const smoke = settle('smoke');
    expect(clear.sun).toBeGreaterThan(rain.sun);
    expect(clear.sun).toBeGreaterThan(fog.sun);
    expect(clear.sun).toBeGreaterThan(smoke.sun);
    expect(fog.ambient).toBeGreaterThan(clear.ambient);
    expect(fog.ambient).toBeGreaterThan(rain.ambient);
    expect(fog.ambient).toBeGreaterThan(smoke.ambient);
  });

  it('keeps a FOGGY NIGHT readable: fog never crushes below the luminance floor + ambient stays floored', () => {
    const h = makeHandles();
    const sys = new LightingSystem(h, CFG);
    for (let i = 0; i < 240; i++) sys.update(1 / 30, fakeRuntime(false, 0.0, 'fog'), 0.0); // midnight, fog
    const maxChannel = Math.max(h.fog.color.r, h.fog.color.g, h.fog.color.b);
    expect(maxChannel).toBeGreaterThanOrEqual(CFG.fogFloorLuminance - 1e-6); // not a black void
    expect(h.ambient.intensity).toBeGreaterThanOrEqual(CFG.minAmbientIntensity - 1e-6); // ambient floored
  });
});
