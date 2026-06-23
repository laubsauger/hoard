// T98 player flashlight system: anchors the SpotLight at the player, aims it along playerAim() so its cone
// covers the same wedge the fog-of-war reveals, and scales its intensity by scene brightness — at night it is
// the main light, by day it is subtle. Off (or zero intensity) hides it cleanly. `sceneBrightness` is the
// 0..1 day/night key+ambient level resolved by the LightingSystem and passed in by the orchestrator (so the
// lighting→flashlight order is preserved). Extracted from BlockScene (docs/REFACTOR-godfiles.md).

import type { SpotLight } from 'three';
import type { GameRuntime } from '../../../game/runtime';
import { rayDistanceToWall } from '../../../game/scene';
import { clampConeRangeToWall } from '../../world/visibility';

export interface FlashlightSystemConfig {
  readonly intensity: number;
  readonly rangeMarginMeters: number;
  readonly wallClampMarginMeters: number;
  readonly heightMeters: number;
  readonly dayIntensityScale: number;
  /** Player vision range (m) — the cone reach before the wall clamp + range margin. */
  readonly visionRange: number;
}

export class FlashlightSystem {
  constructor(
    private readonly flashlight: SpotLight,
    private readonly cfg: FlashlightSystemConfig,
  ) {}

  update(runtime: GameRuntime, sceneBrightness: number, on: boolean): void {
    const f = this.flashlight;
    if (!on) {
      f.visible = false;
      return;
    }
    const p = runtime.player();
    const aim = runtime.playerAim();
    const maxRange = this.cfg.visionRange + this.cfg.rangeMarginMeters;
    // V67: RAYCAST-CLAMPED cone — clip the beam reach to the first STRUCTURAL wall along the aim so it never shines
    // THROUGH/past a wall the player faces (no light spilling outside the building). Reuses the SAME nav-grid wall
    // raycast the shots (rayDistanceToWall) + perception LOS use — not a second wall representation. A small margin
    // keeps the struck wall face itself lit; a clear aim returns maxRange so the cone is never shortened needlessly.
    const wallDist = rayDistanceToWall(runtime.scene, p.x, p.z, aim, maxRange);
    const range = clampConeRangeToWall(maxRange, wallDist, this.cfg.wallClampMarginMeters);
    f.distance = range;
    f.position.set(p.x, this.cfg.heightMeters, p.z);
    // Aim the target forward along the ground (cos/sin aim = the same forward the avatar nose + fire dir use)
    // so the cone rakes from torso height down across the revealed wedge.
    f.target.position.set(p.x + Math.cos(aim) * range, 0, p.z + Math.sin(aim) * range);
    f.target.updateMatrixWorld();
    const dayScale = this.cfg.dayIntensityScale;
    const brightness = Math.min(1, Math.max(0, sceneBrightness));
    f.intensity = this.cfg.intensity * (dayScale + (1 - dayScale) * (1 - brightness));
    f.visible = f.intensity > 0;
  }
}
