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
  readonly wallClampMarginMeters: number;
  readonly heightMeters: number;
  readonly dayIntensityScale: number;
  /** Flashlight's OWN beam reach (m) — decoupled from the player vision range — before the wall clamp. */
  readonly rangeMeters: number;
  /** How far IN FRONT of the player centre the beam originates (at the nose tip), so it reads as held/aimed. */
  readonly noseOffsetMeters: number;
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
    const cos = Math.cos(aim);
    const sin = Math.sin(aim);
    // Beam ORIGIN at the nose tip — a step IN FRONT of the body centre along the aim — so the cone reads as
    // held/aimed, not emanating from the torso. The wall raycast + cone start here too.
    const ox = p.x + cos * this.cfg.noseOffsetMeters;
    const oz = p.z + sin * this.cfg.noseOffsetMeters;
    const maxRange = this.cfg.rangeMeters;
    // V67: RAYCAST-CLAMPED cone — clip the beam reach to the first STRUCTURAL wall along the aim so it never shines
    // THROUGH/past a wall the player faces (no light spilling outside the building). Reuses the SAME nav-grid wall
    // raycast the shots + perception LOS use — not a second wall representation. A small margin keeps the struck
    // wall face itself lit; a clear aim returns maxRange so the cone is never shortened needlessly. V84: clamps on
    // the SEE-THROUGH `sightScene` so the beam passes THROUGH a glassed window (light goes through glass) and is
    // stopped only by a solid wall or a boarded-shut window.
    const wallDist = rayDistanceToWall(runtime.sightScene, ox, oz, aim, maxRange);
    const range = clampConeRangeToWall(maxRange, wallDist, this.cfg.wallClampMarginMeters);
    f.distance = range;
    f.position.set(ox, this.cfg.heightMeters, oz); // origin at the nose tip
    // Aim the target forward along the ground from the nose origin (same forward the avatar nose + fire dir use)
    // so the cone rakes from nose height down across the lit area.
    f.target.position.set(ox + cos * range, 0, oz + sin * range);
    f.target.updateMatrixWorld();
    const dayScale = this.cfg.dayIntensityScale;
    const brightness = Math.min(1, Math.max(0, sceneBrightness));
    f.intensity = this.cfg.intensity * (dayScale + (1 - dayScale) * (1 - brightness));
    f.visible = f.intensity > 0;
  }
}
