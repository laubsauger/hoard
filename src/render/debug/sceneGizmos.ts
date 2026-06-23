// Dev-tools scene gizmos — a self-contained debug overlay layer driven from the viewport (NOT the crowd
// render path). Reads live runtime state (zombie SoA positions/states, stimulus field) + the debug-flag
// store and draws perception/attack radii, per-state markers, and the heard-sound field into its own
// Group. Toggled entirely off (group.visible) when no debug flag is set, so it costs nothing in normal play.
//
// Cheap by construction: each radius layer is ONE merged LineSegments (one draw call) rebuilt in place
// from a preallocated buffer; state markers are ONE Points cloud. No per-zombie object allocation.

import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Points,
  PointsMaterial,
} from 'three';
import { ZombieState, type SimulationZombies } from '@/game/simulation';
import { resolveDomain } from '@/config/registry';
import { perceptionConfig } from '@/config/domains/perception';
import type { QualityTier } from '@/config/types';
import type { DebugFlags } from '@/diagnostics/flags';

/** Max zombies drawn per gizmo layer (debug-only cap — keeps the buffers bounded). */
const MAX_GIZMOS = 600;
/** Segments per debug ring (visual smoothness vs buffer size). */
const RING_SEGMENTS = 32;
/** Lift gizmos clear of the authored floor slab (~0.2m). Combined with depthTest:false the layer always
 *  draws on top of the scene regardless of walls/floor occlusion (standard debug-overlay behaviour). */
const GIZMO_Y = 0.25;

/** FSM-state → marker colour (idle/wander/pursue/attack/stagger/down). */
const STATE_COLOR: Record<number, [number, number, number]> = {
  [ZombieState.Idle]: [0.23, 0.51, 0.96], // blue
  [ZombieState.Wander]: [0.13, 0.83, 0.93], // cyan
  [ZombieState.Pursue]: [0.96, 0.62, 0.04], // amber
  [ZombieState.Attack]: [0.94, 0.27, 0.27], // red
  [ZombieState.Stagger]: [0.92, 0.7, 0.03], // yellow
  [ZombieState.Down]: [0.42, 0.45, 0.5], // gray
};

/** One ring layer: a single merged LineSegments rebuilt in place each frame. */
class RingLayer {
  readonly mesh: LineSegments;
  private readonly positions: Float32Array;

  constructor(color: number, maxRings: number) {
    this.positions = new Float32Array(maxRings * RING_SEGMENTS * 2 * 3);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    this.mesh = new LineSegments(
      geo,
      new LineBasicMaterial({ color, transparent: true, opacity: 0.6, depthTest: false, depthWrite: false }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 999;
  }

  /** Write `count` rings (centre + radius). Returns segments used; caller sets the draw range. */
  build(centres: ArrayLike<number>, count: number, radius: number): void {
    const p = this.positions;
    let o = 0;
    for (let i = 0; i < count; i++) {
      const cx = centres[i * 2]!;
      const cz = centres[i * 2 + 1]!;
      for (let s = 0; s < RING_SEGMENTS; s++) {
        const a0 = (s / RING_SEGMENTS) * Math.PI * 2;
        const a1 = ((s + 1) / RING_SEGMENTS) * Math.PI * 2;
        p[o++] = cx + Math.cos(a0) * radius; p[o++] = GIZMO_Y; p[o++] = cz + Math.sin(a0) * radius;
        p[o++] = cx + Math.cos(a1) * radius; p[o++] = GIZMO_Y; p[o++] = cz + Math.sin(a1) * radius;
      }
    }
    const attr = this.mesh.geometry.getAttribute('position');
    attr.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, count * RING_SEGMENTS * 2);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as LineBasicMaterial).dispose();
  }
}

export class SceneGizmos {
  readonly group = new Group();
  private readonly sight: RingLayer;
  private readonly attack: RingLayer;
  private readonly sound: RingLayer;
  private readonly stateMarkers: Points;
  private readonly markerPos: Float32Array;
  private readonly markerColor: Float32Array;
  private readonly sightRange: number;
  private readonly attackRange: number;
  /** Scratch buffer of zombie XZ centres reused across layers (no per-frame alloc). */
  private readonly centres = new Float32Array(MAX_GIZMOS * 2);

  constructor(tier: QualityTier) {
    const perception = resolveDomain(perceptionConfig, tier);
    this.sightRange = perception.sightRange;
    this.attackRange = perception.attackRangeMeters;

    this.sight = new RingLayer(0x38bdf8, MAX_GIZMOS);
    this.attack = new RingLayer(0xef4444, MAX_GIZMOS);
    this.sound = new RingLayer(0xfacc15, 64);

    this.markerPos = new Float32Array(MAX_GIZMOS * 3);
    this.markerColor = new Float32Array(MAX_GIZMOS * 3);
    const markerGeo = new BufferGeometry();
    markerGeo.setAttribute('position', new Float32BufferAttribute(this.markerPos, 3));
    markerGeo.setAttribute('color', new Float32BufferAttribute(this.markerColor, 3));
    this.stateMarkers = new Points(
      markerGeo,
      new PointsMaterial({
        size: 0.7,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        sizeAttenuation: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.stateMarkers.frustumCulled = false;
    this.stateMarkers.renderOrder = 1000;

    this.group.add(this.sight.mesh, this.attack.mesh, this.sound.mesh, this.stateMarkers);
  }

  /**
   * Rebuild the enabled gizmos from live state. `tick` drives the stimulus query for the sound field.
   * Cheap no-op (group hidden) when no relevant flag is set.
   */
  update(
    zombies: SimulationZombies,
    flags: DebugFlags,
    player: { x: number; z: number },
    queryStimuli: (x: number, z: number) => readonly { x: number; z: number; intensity: number }[],
  ): void {
    const any = flags.showSightRadius || flags.showAttackRadius || flags.showZombieState || flags.showSoundField;
    this.group.visible = any;
    if (!any) return;

    // Gather alive zombie centres + state colours once (shared by every layer).
    const c = this.centres;
    let n = 0;
    const pos: [number, number, number] = [0, 0, 0];
    zombies.forEachAlive((slot) => {
      if (n >= MAX_GIZMOS) return;
      zombies.getPosition(slot, pos);
      c[n * 2] = pos[0];
      c[n * 2 + 1] = pos[2];
      if (flags.showZombieState) {
        const col = STATE_COLOR[zombies.getState(slot)] ?? STATE_COLOR[ZombieState.Idle]!;
        this.markerPos[n * 3] = pos[0];
        this.markerPos[n * 3 + 1] = GIZMO_Y;
        this.markerPos[n * 3 + 2] = pos[2];
        this.markerColor[n * 3] = col[0];
        this.markerColor[n * 3 + 1] = col[1];
        this.markerColor[n * 3 + 2] = col[2];
      }
      n += 1;
    });

    this.sight.mesh.visible = flags.showSightRadius;
    if (flags.showSightRadius) this.sight.build(c, n, this.sightRange);

    this.attack.mesh.visible = flags.showAttackRadius;
    if (flags.showAttackRadius) this.attack.build(c, n, this.attackRange);

    this.stateMarkers.visible = flags.showZombieState;
    if (flags.showZombieState) {
      this.stateMarkers.geometry.getAttribute('position').needsUpdate = true;
      this.stateMarkers.geometry.getAttribute('color').needsUpdate = true;
      this.stateMarkers.geometry.setDrawRange(0, n);
    }

    this.sound.mesh.visible = flags.showSoundField;
    if (flags.showSoundField) {
      // Heard-sound sources reaching the player (V14 — what the player would actually hear). Ring radius
      // scales with attenuated intensity so louder/closer sources read bigger.
      const hits = queryStimuli(player.x, player.z);
      const m = Math.min(hits.length, 64);
      const sc = this.centres; // reuse a separate slice region is overkill; build directly below
      for (let i = 0; i < m; i++) {
        sc[i * 2] = hits[i]!.x;
        sc[i * 2 + 1] = hits[i]!.z;
      }
      // One representative radius per ring would need per-ring scaling; keep it simple + readable with a
      // fixed base scaled by the loudest hit so the field is visible without per-ring geometry.
      const loud = hits.reduce((mx, h) => Math.max(mx, h.intensity), 0);
      this.sound.build(sc, m, 1 + loud * 0.5);
    }
  }

  dispose(): void {
    this.sight.dispose();
    this.attack.dispose();
    this.sound.dispose();
    this.stateMarkers.geometry.dispose();
    (this.stateMarkers.material as PointsMaterial).dispose();
  }
}
