// LightingSystem: the interior exposure transition is monotonic (eyes adapting, not a snap) and lifts exposure
// while indoors; a darker scene gets the night-floor boost. Pure CPU — real Three lights + a fake runtime whose
// scene exposes building bounds (for the isInside test) and a constant clock.

import { describe, it, expect } from 'vitest';
import { AmbientLight, Color, DirectionalLight, Fog, HemisphereLight, Scene } from 'three';
import { LightingSystem, type LightingHandles, type LightingSystemConfig } from './lightingSystem';
import type { GameRuntime } from '../../../game/runtime';

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
};

function makeHandles(): LightingHandles {
  const scene = new Scene();
  scene.background = new Color(0x000000); // lighting copies the fog colour onto an EXISTING Color
  return { scene, sun: new DirectionalLight(), ambient: new AmbientLight(), hemi: new HemisphereLight(), fog: new Fog(0x000000, 1, 400) };
}

// inside: a building footprint covering cell (5,5); outside: bounds far away so the player cell misses.
function fakeRuntime(inside: boolean, timeOfDay: number): GameRuntime {
  const bounds = inside ? { minCx: 0, maxCx: 10, minCy: 0, maxCy: 10 } : { minCx: 100, maxCx: 110, minCy: 100, maxCy: 110 };
  return {
    player: () => ({ x: 5, y: 0, z: 5 }),
    playerAim: () => 0,
    weatherSeverity: 0,
    timeOfDay: () => timeOfDay,
    scene: { buildings: [{ bounds }] },
  } as unknown as GameRuntime;
}

describe('LightingSystem', () => {
  it('raises exposure monotonically as the player settles indoors (no snap)', () => {
    const sys = new LightingSystem(makeHandles(), CFG);
    const rt = fakeRuntime(true, 0.5); // midday, indoors
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

  it('lifts indoor exposure above the matched outdoor exposure (interior compensation)', () => {
    const inside = new LightingSystem(makeHandles(), CFG);
    const outside = new LightingSystem(makeHandles(), CFG);
    for (let i = 0; i < 40; i++) {
      inside.update(1 / 30, fakeRuntime(true, 0.5));
      outside.update(1 / 30, fakeRuntime(false, 0.5));
    }
    expect(inside.currentExposure).toBeGreaterThan(outside.currentExposure);
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
});
