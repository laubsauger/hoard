// FlashlightSystem (B44): the beam axis aims at the near ground (not full range) so the cone tilts down and
// lights the floor close to the player; intensity ramps UP as the scene darkens (the player's main light at
// night); off hides it. Pure CPU — a real Three SpotLight + a fake runtime.

import { describe, it, expect } from 'vitest';
import { SpotLight } from 'three';
import { FlashlightSystem, type FlashlightSystemConfig } from './flashlightSystem';
import type { GameRuntime } from '../../../game/runtime';

const CFG: FlashlightSystemConfig = {
  intensity: 60,
  rangeMeters: 15,
  wallClampMarginMeters: 0.6,
  heightMeters: 1.05,
  dayIntensityScale: 0.32,
  noseOffsetMeters: 0.12,
  aimGroundDistanceMeters: 4,
};

// Player at origin, aiming along +x (playerAim 0 → cos=1, sin=0).
function fakeRuntime(): GameRuntime {
  return { player: () => ({ x: 0, y: 0, z: 0 }), playerAim: () => 0 } as unknown as GameRuntime;
}

describe('FlashlightSystem (B44)', () => {
  it('aims the cone axis at the NEAR ground (closer than full reach) so the near floor falls in the beam', () => {
    const light = new SpotLight();
    const sys = new FlashlightSystem(light, CFG);
    sys.update(fakeRuntime(), 0.5, true);
    // Origin lifted to torch height, just ahead of the player nose.
    expect(light.position.y).toBeCloseTo(CFG.heightMeters, 6);
    expect(light.position.x).toBeCloseTo(CFG.noseOffsetMeters, 6);
    // Target sits ON the ground (y=0) at the near aim distance ahead — NOT at full range (that was the dead-zone bug).
    expect(light.target.position.y).toBe(0);
    expect(light.target.position.x).toBeCloseTo(CFG.noseOffsetMeters + CFG.aimGroundDistanceMeters, 6);
    expect(light.target.position.x).toBeLessThan(CFG.noseOffsetMeters + CFG.rangeMeters);
    // The beam still REACHES full range (throw preserved) — distance is independent of the target point.
    expect(light.distance).toBe(CFG.rangeMeters);
  });

  it('ramps intensity UP as the scene darkens (main light at night, subtle by day)', () => {
    const night = new SpotLight();
    const day = new SpotLight();
    new FlashlightSystem(night, CFG).update(fakeRuntime(), 0, true);
    new FlashlightSystem(day, CFG).update(fakeRuntime(), 1, true);
    expect(night.intensity).toBeGreaterThan(day.intensity);
    expect(night.intensity).toBeCloseTo(CFG.intensity, 6); // full at black
    expect(day.intensity).toBeCloseTo(CFG.intensity * CFG.dayIntensityScale, 6); // subtle at noon
  });

  it('turns off via INTENSITY (never toggles visible) so no pipeline recompile / freeze', () => {
    const light = new SpotLight();
    const sys = new FlashlightSystem(light, CFG);
    sys.update(fakeRuntime(), 0, true); // on
    expect(light.intensity).toBeGreaterThan(0);
    sys.update(fakeRuntime(), 0, false); // off
    expect(light.intensity).toBe(0); // contributes no light
    expect(light.visible).toBe(true); // ...but stays in the render set — toggling visible is what froze the game
    expect(light.shadow.autoUpdate).toBe(false); // shadow re-render paused while off (no per-frame cost)
    sys.update(fakeRuntime(), 0, true); // back on
    expect(light.shadow.autoUpdate).toBe(true);
    expect(light.intensity).toBeGreaterThan(0);
  });
});
