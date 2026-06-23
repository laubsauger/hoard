// Dev-tools scene gizmos — a self-contained debug overlay driven from the viewport (NOT the crowd render
// path). Reads live runtime state (zombie SoA positions/states, stimulus field) + the debug-flag store and
// draws perception/attack radii, per-state markers, and the heard-sound field into its own Group.
//
// WebGPU note: core LineBasicMaterial/PointsMaterial do NOT render under three's WebGPURenderer (only
// node materials do). Even LineBasicNodeMaterial/PointsNodeMaterial proved unreliable here, so the layer
// is built the SAME way the crowd is — InstancedMesh + MeshBasicNodeMaterial — which is confirmed to draw.
// Radii = instanced flat ring meshes (scaled per agent); state = instanced boxes (per-instance colour).

import {
  BoxGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  RingGeometry,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { ZombieState, type SimulationZombies } from '@/game/simulation';
import { resolveDomain } from '@/config/registry';
import { perceptionConfig } from '@/config/domains/perception';
import type { QualityTier } from '@/config/types';
import type { DebugFlags } from '@/diagnostics/flags';

/** Max zombies drawn per gizmo layer (debug-only cap — keeps instance buffers bounded). */
const MAX_GIZMOS = 600;
const MAX_SOUND = 64;
/** Lift gizmos clear of the authored floor slab (~0.2m); depthTest:false keeps them on top regardless. */
const GIZMO_Y = 0.25;

/** FSM-state → marker colour (idle/wander/pursue/attack/stagger/down). */
const STATE_RGB: Record<number, [number, number, number]> = {
  [ZombieState.Idle]: [0.23, 0.51, 0.96],
  [ZombieState.Wander]: [0.13, 0.83, 0.93],
  [ZombieState.Pursue]: [0.96, 0.62, 0.04],
  [ZombieState.Attack]: [0.94, 0.27, 0.27],
  [ZombieState.Stagger]: [0.92, 0.7, 0.03],
  [ZombieState.Down]: [0.42, 0.45, 0.5],
};

function gizmoMaterial(color: number): MeshBasicNodeMaterial {
  return new MeshBasicNodeMaterial({
    color,
    transparent: true,
    opacity: 0.55,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });
}

/** A pool of flat ring meshes (one per agent), scaled to a fixed radius. Instanced = one draw call. */
class RingLayer {
  readonly mesh: InstancedMesh;
  private readonly m = new Matrix4();

  constructor(color: number, max: number) {
    const geo = new RingGeometry(0.9, 1.0, 40);
    geo.rotateX(-Math.PI / 2); // XY ring → lies flat in the XZ ground plane
    this.mesh = new InstancedMesh(geo, gizmoMaterial(color), max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 999;
    this.mesh.count = 0;
  }

  build(centres: ArrayLike<number>, count: number, radius: number): void {
    for (let i = 0; i < count; i++) {
      this.m.makeScale(radius, 1, radius);
      this.m.setPosition(centres[i * 2]!, GIZMO_Y, centres[i * 2 + 1]!);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
  }
}

export class SceneGizmos {
  readonly group = new Group();
  private readonly sight: RingLayer;
  private readonly attack: RingLayer;
  private readonly sound: RingLayer;
  private readonly markers: InstancedMesh;
  private readonly markerM = new Matrix4();
  private readonly markerColor = new Color();
  private readonly sightRange: number;
  private readonly attackRange: number;
  private readonly centres = new Float32Array(MAX_GIZMOS * 2);
  private readonly soundCentres = new Float32Array(MAX_SOUND * 2);

  constructor(tier: QualityTier) {
    const perception = resolveDomain(perceptionConfig, tier);
    this.sightRange = perception.sightRange;
    this.attackRange = perception.attackRangeMeters;

    this.sight = new RingLayer(0x38bdf8, MAX_GIZMOS);
    this.attack = new RingLayer(0xef4444, MAX_GIZMOS);
    this.sound = new RingLayer(0xfacc15, MAX_SOUND);

    this.markers = new InstancedMesh(new BoxGeometry(0.6, 0.6, 0.6), gizmoMaterial(0xffffff), MAX_GIZMOS);
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 1000;
    this.markers.count = 0;

    this.group.add(this.sight.mesh, this.attack.mesh, this.sound.mesh, this.markers);
  }

  update(
    zombies: SimulationZombies,
    flags: DebugFlags,
    player: { x: number; z: number },
    queryStimuli: (x: number, z: number) => readonly { x: number; z: number; intensity: number }[],
  ): void {
    const any = flags.showSightRadius || flags.showAttackRadius || flags.showZombieState || flags.showSoundField;
    this.group.visible = any;
    if (!any) return;

    const c = this.centres;
    let n = 0;
    const pos: [number, number, number] = [0, 0, 0];
    zombies.forEachAlive((slot) => {
      if (n >= MAX_GIZMOS) return;
      zombies.getPosition(slot, pos);
      c[n * 2] = pos[0];
      c[n * 2 + 1] = pos[2];
      if (flags.showZombieState) {
        const rgb = STATE_RGB[zombies.getState(slot)] ?? STATE_RGB[ZombieState.Idle]!;
        this.markerM.makeTranslation(pos[0], GIZMO_Y + 0.4, pos[2]);
        this.markers.setMatrixAt(n, this.markerM);
        this.markers.setColorAt(n, this.markerColor.setRGB(rgb[0], rgb[1], rgb[2]));
      }
      n += 1;
    });

    this.sight.mesh.visible = flags.showSightRadius;
    if (flags.showSightRadius) this.sight.build(c, n, this.sightRange);

    this.attack.mesh.visible = flags.showAttackRadius;
    if (flags.showAttackRadius) this.attack.build(c, n, this.attackRange);

    this.markers.visible = flags.showZombieState;
    if (flags.showZombieState) {
      this.markers.count = n;
      this.markers.instanceMatrix.needsUpdate = true;
      if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
    }

    this.sound.mesh.visible = flags.showSoundField;
    if (flags.showSoundField) {
      const hits = queryStimuli(player.x, player.z);
      const m = Math.min(hits.length, MAX_SOUND);
      for (let i = 0; i < m; i++) {
        this.soundCentres[i * 2] = hits[i]!.x;
        this.soundCentres[i * 2 + 1] = hits[i]!.z;
      }
      const loud = hits.reduce((mx, h) => Math.max(mx, h.intensity), 0);
      this.sound.build(this.soundCentres, m, 1 + loud * 0.5);
    }
  }

  dispose(): void {
    this.sight.dispose();
    this.attack.dispose();
    this.sound.dispose();
    this.markers.geometry.dispose();
    (this.markers.material as MeshBasicNodeMaterial).dispose();
  }
}
