// PER-BUILDING cutaway system (V59): fades the roof + upper walls of ONLY the building the player currently
// occupies (its neighbours stay opaque so the district reads as solid streets). DIRECTIONAL (V58): a wall fades
// when its outward normal turns toward the camera OR its plane lies between player↔camera (V66); roofs always
// occlude from above. OUTSIDE-WALL (V62): an exterior wall the player hugs fades while it hides them.
//
// HIGH-RISK invariants this preserves byte-for-byte:
//   • V20 — a FADED surface stops writing depth (`depthWrite = opacity >= 0.99`) so it can't depth-occlude the
//     interior floor / blood decals / units below it ("blood invisible indoors").
//   • V60 — a faded surface KEEPS `object.visible = true` so it still casts shadows + occludes light (the
//     cutaway is a CAMERA-only view aid; the shadow depth pass ignores opacity).
//   • V29 — motion reduction snaps the fade instantly (fadeRate = 1) instead of animating it.
//
// Extracted from BlockScene (docs/REFACTOR-godfiles.md).

import type { Camera } from 'three';
import type { GameRuntime } from '../../../game/runtime';
import {
  resolveSurfaceVisibility,
  wallFacesCamera,
  exteriorWallOccludesPlayer,
  wallBetweenPlayerAndCamera,
  type OcclusionContext,
  type VisibilitySettings,
  type VecXZ,
} from '../../world/visibility';
import type { FadeSurface } from '../builders/handles';
import { buildingIndexAt } from './playerLocation';

export interface CutawaySystemConfig {
  readonly visibility: VisibilitySettings;
  readonly roofFadeSeconds: number;
  readonly navCellSize: number;
}

export class CutawaySystem {
  constructor(
    private readonly fadeSurfaces: FadeSurface[],
    private readonly cfg: CutawaySystemConfig,
  ) {}

  update(runtime: GameRuntime, camera: Camera | undefined, dtSeconds: number, reduceMotion: boolean): void {
    // PER-BUILDING cutaway (V59): only the building the player currently occupies fades; its neighbours stay
    // opaque so the district still reads as solid streets of houses.
    const player = runtime.player();
    const insideIndex = buildingIndexAt(runtime.scene, this.cfg.navCellSize, player.x, player.z);
    // V29 motion reduction: cut roofs/upper walls instantly rather than animating the fade (less motion).
    const fadeRate = reduceMotion ? 1 : this.cfg.roofFadeSeconds > 0 ? dtSeconds / this.cfg.roofFadeSeconds : 1;
    // T82/V58 DIRECTIONAL cutaway: derive the horizontal player→camera direction from the camera position. A
    // wall fades only when its outward normal turns toward the camera; the roof always occludes from above.
    let towardCamera: VecXZ | null = null;
    if (camera) {
      const dx = camera.position.x - player.x;
      const dz = camera.position.z - player.z;
      if (Math.hypot(dx, dz) > 1e-6) towardCamera = { x: dx, z: dz };
    }
    for (const s of this.fadeSurfaces) {
      const playerInside = insideIndex >= 0 && s.buildingIndex === insideIndex;
      let occludesPlayerView: boolean;
      if (towardCamera === null || camera === undefined) {
        occludesPlayerView = false; // no camera (construction prime) → stay opaque
      } else if (playerInside) {
        // Occupied building (V58/V59): roof always occludes from above. A wall fades when it turns toward the
        // camera (V58 directional test) OR — GENERIC player↔camera occlusion (V66) — when its plane actually lies
        // between the player and the camera. The second term catches INTERIOR walls (whose guessed outward normal
        // need not point at the camera) that hide the player on the sightline; the directional term preserves the
        // existing whole-near-side exterior fade. Either making it true fades the wall to the sliver (V65).
        occludesPlayerView = s.kind === 'roof' || s.outwardNormal === null
          ? true
          : wallFacesCamera({
              outwardNormal: s.outwardNormal,
              towardCamera,
              facingDotThreshold: this.cfg.visibility.cameraFacingDotThreshold,
            }) ||
            wallBetweenPlayerAndCamera({
              outwardNormal: s.outwardNormal,
              wallCenter: { x: s.centerX, z: s.centerZ },
              player: { x: player.x, z: player.z },
              camera: { x: camera.position.x, z: camera.position.z },
              lateralSpanMeters: this.cfg.visibility.occluderLateralSpanMeters,
            });
      } else if (s.kind === 'upperWall' && s.outwardNormal !== null) {
        // OUTSIDE-WALL cutaway (V62): the player is OUTSIDE this building — fade an exterior wall only when the
        // player hugs it AND it lies between the camera and the player, so it never hides the player. Roofs of
        // un-occupied buildings stay opaque (the player isn't under them). VIEW-only — structural LOS unchanged.
        occludesPlayerView = exteriorWallOccludesPlayer({
          outwardNormal: s.outwardNormal,
          wallCenter: { x: s.centerX, z: s.centerZ },
          player: { x: player.x, z: player.z },
          camera: { x: camera.position.x, z: camera.position.z },
          adjacencyMeters: this.cfg.visibility.exteriorCutawayAdjacencyMeters,
        });
      } else {
        occludesPlayerView = false;
      }
      const ctx: OcclusionContext = {
        playerInside,
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
