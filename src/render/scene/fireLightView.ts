// T148 — warm LIGHT emission from fires (molotov pools + burning zombies). A small pool of orange PointLights (NO
// shadows — cheap) assigned to the fire emitters NEAREST the camera and INTENSITY-pulsed for a fire flicker. Like
// the torch lights (and for the same reason — B45), the lights are pre-pooled + kept permanently present, driven to
// intensity 0 when idle, NEVER toggled `visible` → the active-light count never changes → no WebGPU pipeline
// recompile / freeze. Distant fires keep their billboards but share no dedicated light (tiered, no presence cliff —
// V117). Render-only (V2); V24-tracked.

import { Color, Group, PointLight } from 'three';
import type { Disposable, ResourceKind } from '../engine/resources';

type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;
/** A fire emitter: ground position + a radius (drives light range) + a base intensity (pool > burning zombie). */
export type FireEmitter = { readonly x: number; readonly z: number; readonly radius: number; readonly intensity: number };

export class FireLightView {
  readonly group = new Group();
  private readonly lights: PointLight[] = [];
  private clock = 0;

  constructor(track: TrackFn, maxLights: number) {
    this.group.name = 'fireLights';
    for (let i = 0; i < Math.max(0, maxLights); i++) {
      const l = new PointLight(new Color(1, 0.5, 0.2), 0, 12, 2);
      l.castShadow = false;
      this.group.add(l); // permanently present (intensity 0 when idle) — never toggled visible (B45).
      this.lights.push(l);
      track(l, 'other', `fire.light.${i}`);
    }
  }

  /** Assign the pooled lights to the fire emitters nearest the camera; pulse each with a warm flicker; idle the rest. */
  sync(emitters: readonly FireEmitter[], groundY: number, dtSeconds: number, cameraX: number, cameraZ: number): void {
    this.clock += Math.max(0, dtSeconds);
    if (this.lights.length === 0) return;
    const nearest = [...emitters]
      .sort((a, b) => (a.x - cameraX) ** 2 + (a.z - cameraZ) ** 2 - ((b.x - cameraX) ** 2 + (b.z - cameraZ) ** 2))
      .slice(0, this.lights.length);
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i]!;
      const e = nearest[i];
      if (!e) {
        l.intensity = 0;
        continue;
      }
      l.position.set(e.x, groundY + 0.7, e.z);
      l.distance = Math.min(16, Math.max(5, e.radius * 4.5));
      const t = this.clock * 8 + i * 2.1;
      const flicker = 0.78 + 0.16 * Math.sin(t) + 0.08 * Math.sin(t * 3.7); // two-rate warm flicker
      l.intensity = e.intensity * Math.max(0.3, flicker);
    }
  }
}
