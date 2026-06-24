// T98 player flashlight system: anchors the SpotLight at the player, aims it along playerAim() so its cone
// covers the same wedge the fog-of-war reveals, and scales its intensity by scene brightness — at night it is
// the main light, by day it is subtle. Off (or zero intensity) hides it cleanly. `sceneBrightness` is the
// 0..1 day/night key+ambient level resolved by the LightingSystem and passed in by the orchestrator (so the
// lighting→flashlight order is preserved). Extracted from BlockScene (docs/REFACTOR-godfiles.md).

import type { SpotLight } from 'three';
import type { GameRuntime } from '../../../game/runtime';

export interface FlashlightSystemConfig {
  readonly intensity: number;
  readonly wallClampMarginMeters: number;
  readonly heightMeters: number;
  readonly dayIntensityScale: number;
  /** Flashlight's OWN beam reach (m) — decoupled from the player vision range — before the wall clamp. */
  readonly rangeMeters: number;
  /** How far IN FRONT of the player centre the beam originates (at the nose tip), so it reads as held/aimed. */
  readonly noseOffsetMeters: number;
  /** Ground distance ahead the beam AXIS aims at — closer than rangeMeters so the cone tilts DOWN and lights the near floor (B44). */
  readonly aimGroundDistanceMeters: number;
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
    const range = this.cfg.rangeMeters;
    // V88: the beam reaches its FULL range so the wall the player faces is brightly LIT — the SpotLight's distance
    // falloff dims anything near the cutoff, so the old raycast-clamp (distance ≈ wallDist + small margin) left the
    // struck wall at the falloff edge → ~10% brightness → dark. Spill PAST the wall is blocked accurately by the
    // flashlight's own castShadow (shadow camera.far = full range), which is per-pixel — strictly better than the
    // single-ray clamp, and a glassed window still passes light (it casts no opaque shadow), matching V84.
    f.distance = range;
    f.position.set(ox, this.cfg.heightMeters, oz); // origin at the nose tip
    // B44: aim the target at the ground a SHORT distance ahead (aimGroundDistanceMeters, << range) rather than at
    // full range — this tilts the cone AXIS steeply DOWN so its lower edge meets the floor close to the player
    // (no dark ring at the feet) while it rakes forward. The beam still REACHES `range` (set via f.distance above,
    // which is independent of where the target points), so the throw is preserved.
    const aimDist = Math.min(this.cfg.aimGroundDistanceMeters, range);
    f.target.position.set(ox + cos * aimDist, 0, oz + sin * aimDist);
    f.target.updateMatrixWorld();
    const dayScale = this.cfg.dayIntensityScale;
    const brightness = Math.min(1, Math.max(0, sceneBrightness));
    f.intensity = this.cfg.intensity * (dayScale + (1 - dayScale) * (1 - brightness));
    f.visible = f.intensity > 0;
  }
}
