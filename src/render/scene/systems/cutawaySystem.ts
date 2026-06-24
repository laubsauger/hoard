// X-RAY BUBBLE cutaway system (T110/V74): ONE generic pass over EVERY fade surface (all buildings' roofs + walls,
// exterior + neighbour included), regardless of which building the player occupies. A surface fades when it lies
// IN THE WAY of the camera→player sightline AND is within the x-ray RADIUS of the player — a Project-Zomboid-style
// cutaway bubble that follows the player and only dissolves nearby occluders (`surfaceInXrayField`). This replaces
// the old occupied-building (V59) + outside-wall HUG (V62) gates, which left the player hidden behind any wall they
// were not occupying/hugging. Roofs occlude from above (radius alone); walls must also lie between player + camera.
//
// HIGH-RISK invariants this preserves byte-for-byte:
//   • V20/V56 — a FADED surface stops writing depth (`depthWrite = opacity >= 0.99`) so it can't depth-occlude the
//     interior floor / blood decals / units below it ("blood invisible indoors").
//   • V60 — a faded surface KEEPS `object.visible = true` so it still casts shadows + occludes light (the
//     cutaway is a CAMERA-only view aid; the shadow depth pass ignores opacity).
//   • V29 — motion reduction snaps the fade instantly (fadeRate = 1) instead of animating it.
//   • V65 — a faded surface eases toward the SLIVER min-opacity, never fully vanishing.
//
// Extracted from BlockScene (docs/REFACTOR-godfiles.md).

import type { Camera } from 'three';
import type { GameRuntime } from '../../../game/runtime';
import {
  resolveSurfaceVisibility,
  surfaceInXrayField,
  type OcclusionContext,
  type VisibilitySettings,
} from '../../world/visibility';
import type { FadeSurface } from '../builders/handles';

export interface CutawaySystemConfig {
  readonly visibility: VisibilitySettings;
  readonly roofFadeSeconds: number;
}

export class CutawaySystem {
  constructor(
    private readonly fadeSurfaces: FadeSurface[],
    private readonly cfg: CutawaySystemConfig,
  ) {}

  update(runtime: GameRuntime, camera: Camera | undefined, dtSeconds: number, reduceMotion: boolean): void {
    const player = runtime.player();
    // V29 motion reduction: cut roofs/upper walls instantly rather than animating the fade (less motion).
    const fadeRate = reduceMotion ? 1 : this.cfg.roofFadeSeconds > 0 ? dtSeconds / this.cfg.roofFadeSeconds : 1;
    const camX = camera ? camera.position.x : 0;
    const camZ = camera ? camera.position.z : 0;
    for (const s of this.fadeSurfaces) {
      // X-RAY BUBBLE (V74): the SAME generic predicate for every surface of every building — a wall fades when it
      // lies between the player and the camera AND is within the x-ray radius; a roof fades when the player is
      // under/near its footprint within the radius. No occupied-building special case — so the player is no longer
      // hidden behind a neighbour/exterior wall, yet the bubble stays radius-selective (distant houses stay solid).
      const occludesPlayerView =
        camera === undefined
          ? false // construction prime (no camera) → stay opaque
          : surfaceInXrayField({
              outwardNormal: s.outwardNormal,
              surfaceCenter: { x: s.centerX, z: s.centerZ },
              surfaceHalfExtent: { x: s.halfX, z: s.halfZ },
              player: { x: player.x, z: player.z },
              camera: { x: camX, z: camZ },
              radiusMeters: this.cfg.visibility.xrayRadiusMeters,
              roofRadiusMeters: this.cfg.visibility.roofXrayRadiusMeters,
              sightlineMarginMeters: this.cfg.visibility.sightlineMarginMeters,
            });
      const ctx: OcclusionContext = {
        // `playerInside` only drives the 'interior' surface case in resolveSurfaceVisibility; fade surfaces are
        // always 'roof'/'upperWall', so it is inert here — the bubble decides occlusion per surface (V74).
        playerInside: false,
        occludesPlayerView,
        roomEnclosed: true,
        portalOrLosToCamera: false,
        surfaceHeightMeters: s.heightMeters,
      };
      const decision = resolveSurfaceVisibility(s.kind, ctx, this.cfg.visibility);
      const target = decision.visible ? decision.targetOpacity : 0;
      if (dtSeconds <= 0) s.opacity = target;
      else s.opacity += (target - s.opacity) * Math.min(1, fadeRate);
      s.material.opacity = s.opacity;
      // V20 layering: a FADED roof/upper-wall must not depth-occlude the interior floor, blood decals, or units
      // below it (the "blood invisible indoors" root cause). Stop writing depth while faded; restore it when
      // fully opaque so a non-cutaway roof occludes normally.
      s.material.depthWrite = s.opacity >= 0.99;
      // V60: the cutaway is a VIEW AID ONLY — hiding a surface for the camera must NOT change the sim's physical
      // light. A faded roof/wall stays in the scene (visible=true) so it KEEPS casting shadows + occluding light
      // exactly as if solid; only the CAMERA sees through it (opacity). The shadow pass renders it via the depth
      // material, which ignores opacity, so a hidden roof still shadows the interior as a real roof would. (Sound
      // + physics already key off the structural/nav grid, never this mesh, so they were never affected.)
      s.object.visible = true;
    }
  }
}
