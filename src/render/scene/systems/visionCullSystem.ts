// PLAYER PERCEPTION v2 (V62) vision-cull system: builds this frame's player vision wedge for the crowd
// fog-of-war cull (T98) — the forward cone (player FOV) + reveal range + a wall line-of-sight test, all from
// typed config + the live player pose. Owns the RENDER-side recently-seen memory + a per-slot reveal scratch
// buffer; both are view state only (fed by frame dt) and NEVER read back into the deterministic sim (V26).
// Sized to the SoA capacity so a reveal exists for every possible zombie slot with no per-frame allocation
// (V24). Extracted from BlockScene (docs/REFACTOR-godfiles.md).

import type { GameRuntime } from '../../../game/runtime';
import { hasLineOfSight } from '../../../game/scene';
import { ZombieState } from '../../../game/simulation';
import type { VisionCull } from '../../crowd/visionCull';
import { instantaneousReveal, PerceptionMemory, type RevealParams } from '../../crowd/perceptionMemory';

export interface VisionCullSystemConfig {
  readonly playerFieldOfViewDegrees: number;
  readonly playerVisionRange: number;
  readonly playerVisionRangeFadeMeters: number;
  readonly playerVisionConeFadeDegrees: number;
  readonly playerNearAwarenessRadiusMeters: number;
  readonly hearingRange: number;
  readonly soundWallOcclusion: number;
  readonly playerSightMemorySeconds: number;
}

export class VisionCullSystem {
  private readonly perceptionMemory: PerceptionMemory;
  private readonly perceptionReveal: Float32Array;

  constructor(
    zombieCapacity: number,
    private readonly cfg: VisionCullSystemConfig,
  ) {
    this.perceptionMemory = new PerceptionMemory(zombieCapacity);
    this.perceptionReveal = new Float32Array(zombieCapacity);
  }

  /** V90: this frame's memory-blended reveal (0..1) for a zombie SLOT — the SAME value the crowd packs as the
   *  per-instance fade. 1 = fully visible, 0 = culled/faded. Out-of-range slot → 1 (don't hide). Read by
   *  body-anchored gore (blood/wounds) so a splat fades WITH its zombie instead of floating at full opacity. */
  revealOf(slot: number): number {
    if (slot < 0 || slot >= this.perceptionReveal.length) return 1;
    const r = this.perceptionReveal[slot]!;
    return r < 0 ? 0 : r > 1 ? 1 : r;
  }

  /**
   * Build this frame's reveal. `passiveRadiusMeters` is the live, ambient-scaled passive awareness radius
   * (T109/V72) used as the omnidirectional near-reveal radius; when omitted (e.g. tests / the construction
   * prime) it falls back to the configured night-floor `playerNearAwarenessRadiusMeters`.
   */
  build(runtime: GameRuntime, dtSeconds: number, passiveRadiusMeters?: number): VisionCull {
    const p = runtime.player();
    // V83/V84: route LOS through the SEE-THROUGH `sightScene` so the player's vision reveal sees THROUGH a glassed
    // window (glass is transparent) and is blocked only by a boarded-shut (2-board) one — the same window
    // semantics as zombie sight + the flashlight, all on the ONE shared raycast.
    const sightScene = runtime.sightScene;
    const los = (x0: number, z0: number, x1: number, z1: number): boolean => hasLineOfSight(sightScene, x0, z0, x1, z1);
    // The cone wedge PLUS the near/noise reveal params. The combined per-slot reveal is max(cone, near, memory,
    // noise) — see perceptionMemory.ts. LOS routes through the STRUCTURAL hasLineOfSight (nav grid), never mesh
    // opacity, so a faded cutaway wall can't reveal the zombies behind it (V63). The near radius scales with
    // ambient light (T109): brighter day → larger passive radius (you sense further all around you).
    const nearRadius = passiveRadiusMeters ?? this.cfg.playerNearAwarenessRadiusMeters;
    const params: RevealParams = {
      px: p.x,
      pz: p.z,
      heading: runtime.playerAim(),
      fovHalf: (this.cfg.playerFieldOfViewDegrees * Math.PI) / 360,
      range: this.cfg.playerVisionRange,
      edgeBandMeters: this.cfg.playerVisionRangeFadeMeters,
      edgeBandRadians: (this.cfg.playerVisionConeFadeDegrees * Math.PI) / 180,
      nearRadiusMeters: nearRadius,
      hearingRange: this.cfg.hearingRange,
      soundWallOcclusion: this.cfg.soundWallOcclusion,
      lineOfSight: los,
    };

    // Precompute the per-slot reveal once per frame (read by BOTH packing paths so they always agree), folding in
    // the stateful recently-seen memory. RENDER-side only — no sim state touched (V26). Matches packing's slot
    // iteration (0..count) exactly so reveal[slot] aligns with the slot each packer reads.
    const zombies = runtime.zombies;
    const count = zombies.count;
    const views = zombies.views;
    const position = views.position as Float32Array;
    const alive = views.alive as Uint8Array;
    const state = views.state as Uint8Array;
    const memSec = this.cfg.playerSightMemorySeconds;
    const reveal = this.perceptionReveal;
    for (let slot = 0; slot < count; slot++) {
      let inst = 0;
      if (alive[slot] === 1) {
        const x = position[slot * 3]!;
        const z = position[slot * 3 + 2]!;
        const st = state[slot]!;
        const loud = st === ZombieState.Pursue || st === ZombieState.Attack;
        inst = instantaneousReveal(x, z, loud, params);
      }
      reveal[slot] = this.perceptionMemory.step(slot, inst, dtSeconds, memSec);
    }

    return {
      px: params.px,
      pz: params.pz,
      heading: params.heading,
      fovHalf: params.fovHalf,
      range: params.range,
      edgeBandMeters: params.edgeBandMeters,
      edgeBandRadians: params.edgeBandRadians,
      lineOfSight: los,
      reveal,
    };
  }
}
