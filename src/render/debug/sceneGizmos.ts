// Dev-tools scene gizmos — perception cones, attack radii, FSM-state markers, heard-sound field, and the
// player vision cone. Driven from the viewport; reads live runtime state + the debug-flag store. Built the
// SAME way the crowd is — InstancedMesh + MeshBasicNodeMaterial — which is the only primitive confirmed to
// render under three's WebGPURenderer (core Line/Points materials do not). Self-hides when no flag is set.
//
// Sight is a heading-oriented CONE (matches the zombie FOV in perception, V14) — NOT a 360° ring. Rings use
// a FIXED world-space thickness (geometry built at the true radius) so a big range never produces a fat band.

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  RingGeometry,
  Vector3,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { ZombieState, type SimulationZombies } from '@/game/simulation';
import { resolveDomain } from '@/config/registry';
import { perceptionConfig } from '@/config/domains/perception';
import type { QualityTier } from '@/config/types';
import type { DebugFlags } from '@/diagnostics/flags';

const MAX_GIZMOS = 600;
const MAX_SOUND = 64;
const GIZMO_Y = 0.25;
const RING_THICKNESS = 0.18; // constant world-space ring thickness (T58 feedback: no radius-scaled fat bands)
const SIGHT_CONE_WORLD_STROKE = 0.05; // sight-cone outline stroke in WORLD meters — thin line, bounded so a
// big sight range never fattens it (the relative width is derived = stroke / sightRange in the constructor).
const Y_AXIS = new Vector3(0, 1, 0);

const STATE_RGB: Record<number, [number, number, number]> = {
  [ZombieState.Idle]: [0.23, 0.51, 0.96],
  [ZombieState.Wander]: [0.13, 0.83, 0.93],
  [ZombieState.Pursue]: [0.96, 0.62, 0.04],
  [ZombieState.Attack]: [0.94, 0.27, 0.27],
  [ZombieState.Stagger]: [0.92, 0.7, 0.03],
  [ZombieState.Down]: [0.42, 0.45, 0.5],
};

function gizmoMaterial(color: number, opacity = 0.5): MeshBasicNodeMaterial {
  return new MeshBasicNodeMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: DoubleSide });
}

/** Flat filled sector (vision cone) in the XZ plane: apex at origin, bisector along +x, given half-angle. */
function makeSector(radius: number, halfAngle: number, segs = 28): BufferGeometry {
  const p: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a0 = -halfAngle + (2 * halfAngle * i) / segs;
    const a1 = -halfAngle + (2 * halfAngle * (i + 1)) / segs;
    p.push(0, 0, 0, Math.cos(a0) * radius, 0, Math.sin(a0) * radius, Math.cos(a1) * radius, 0, Math.sin(a1) * radius);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(p, 3));
  return g;
}

/** Flat annulus in the XZ plane at a fixed radius + constant thickness. */
function makeRing(radius: number, thickness: number, segs = 48): BufferGeometry {
  const g = new RingGeometry(Math.max(0.01, radius - thickness), radius, segs);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Unit vision-cone OUTLINE (arc rim + two apex→rim edges) in the XZ plane — thin, no fill, so overlapping
 *  cones never opaque the scene. `w` is the relative stroke width; scaled per instance by the cone radius. */
function makeConeOutline(halfAngle: number, segs = 24, w = 0.02): BufferGeometry {
  const p: number[] = [];
  const ri = 1 - w;
  const arc = (a: number, r: number): [number, number] => [Math.cos(a) * r, Math.sin(a) * r];
  for (let i = 0; i < segs; i++) {
    const a0 = -halfAngle + (2 * halfAngle * i) / segs;
    const a1 = -halfAngle + (2 * halfAngle * (i + 1)) / segs;
    const [ix0, iz0] = arc(a0, ri); const [ox0, oz0] = arc(a0, 1);
    const [ix1, iz1] = arc(a1, ri); const [ox1, oz1] = arc(a1, 1);
    p.push(ix0, 0, iz0, ox0, 0, oz0, ox1, 0, oz1, ix0, 0, iz0, ox1, 0, oz1, ix1, 0, iz1);
  }
  for (const a of [-halfAngle, halfAngle]) {
    const dx = Math.cos(a); const dz = Math.sin(a);
    const px = -dz * w * 0.5; const pz = dx * w * 0.5; // perpendicular half-width
    p.push(px, 0, pz, dx + px, 0, dz + pz, dx - px, 0, dz - pz, px, 0, pz, dx - px, 0, dz - pz, -px, 0, -pz);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(p, 3));
  return g;
}

/** One instanced layer: compose a transform per instance (position + Y-rotation + non-uniform scale). */
class InstancedLayer {
  readonly mesh: InstancedMesh;
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly s = new Vector3();
  private readonly m = new Matrix4();

  constructor(geo: BufferGeometry, color: number, max: number, order: number, opacity = 0.5) {
    this.mesh = new InstancedMesh(geo, gizmoMaterial(color, opacity), max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.count = 0;
  }

  set(i: number, x: number, z: number, rotY: number, sx: number, sz: number): void {
    this.q.setFromAxisAngle(Y_AXIS, rotY);
    this.v.set(x, GIZMO_Y, z);
    this.s.set(sx, 1, sz);
    this.m.compose(this.v, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
  }

  setColor(i: number, c: Color): void {
    this.mesh.setColorAt(i, c);
  }

  finalize(count: number): void {
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
  }
}

export class SceneGizmos {
  readonly group = new Group();
  private readonly sight: InstancedLayer; // heading-oriented cone (unit radius, scaled per agent)
  private readonly attack: InstancedLayer; // thin ring baked at attackRange (translate only)
  private readonly sound: InstancedLayer; // unit ring scaled per own radius
  private readonly markers: InstancedLayer; // state boxes
  private readonly playerCone: Mesh;
  private readonly markerColor = new Color();
  private readonly sightRange: number;
  private readonly playerFovHalf: number;

  constructor(tier: QualityTier) {
    const p = resolveDomain(perceptionConfig, tier);
    this.sightRange = p.sightRange;
    const fovHalf = (p.fieldOfViewDegrees * Math.PI) / 360;

    // Derive the cone-outline stroke so it reads as a THIN fixed world-space line regardless of sight range
    // (geometry is unit-radius scaled per instance by the range, so relative width = worldStroke / range).
    const sightStroke = SIGHT_CONE_WORLD_STROKE / Math.max(0.01, this.sightRange);
    this.sight = new InstancedLayer(makeConeOutline(fovHalf, 24, sightStroke), 0x38bdf8, MAX_GIZMOS, 998, 0.85);
    this.attack = new InstancedLayer(makeRing(p.attackRangeMeters, RING_THICKNESS), 0xef4444, MAX_GIZMOS, 999, 0.7);
    this.sound = new InstancedLayer(makeRing(1, RING_THICKNESS), 0xfacc15, MAX_SOUND, 999, 0.6);
    this.markers = new InstancedLayer(new BoxGeometry(0.6, 0.6, 0.6), 0xffffff, MAX_GIZMOS, 1000, 0.95);

    this.playerFovHalf = (p.playerFieldOfViewDegrees * Math.PI) / 360;
    this.playerCone = new Mesh(makeSector(p.playerVisionRange, this.playerFovHalf), gizmoMaterial(0x86efac, 0.18));
    this.playerCone.frustumCulled = false;
    this.playerCone.renderOrder = 998;
    this.playerCone.position.y = GIZMO_Y;
    this.playerCone.visible = false;

    this.group.add(this.sight.mesh, this.attack.mesh, this.sound.mesh, this.markers.mesh, this.playerCone);
  }

  update(
    zombies: SimulationZombies,
    flags: DebugFlags,
    player: { x: number; z: number; heading: number },
    queryStimuli: (x: number, z: number) => readonly { x: number; z: number; intensity: number; radius: number }[],
    wallDistance?: (x: number, z: number, heading: number, maxR: number) => number,
  ): void {
    const showPlayer = flags.showPlayerVision;
    const any =
      flags.showSightRadius || flags.showAttackRadius || flags.showZombieState || flags.showSoundField || showPlayer;
    this.group.visible = any;
    if (!any) return;

    // Player vision cone (single mesh) — orient to the aim heading. Nose is +x, so rotateY(-heading).
    this.playerCone.visible = showPlayer;
    if (showPlayer) {
      this.playerCone.position.set(player.x, GIZMO_Y, player.z);
      this.playerCone.rotation.y = -player.heading;
    }

    let n = 0;
    const pos: [number, number, number] = [0, 0, 0];
    zombies.forEachAlive((slot) => {
      if (n >= MAX_GIZMOS) return;
      zombies.getPosition(slot, pos);
      const heading = zombies.getHeading(slot);
      if (flags.showSightRadius) {
        // V47: crop the cone at the first wall along the heading so the overlay shows the OCCLUDED sight.
        const r = wallDistance ? wallDistance(pos[0], pos[2], heading, this.sightRange) : this.sightRange;
        this.sight.set(n, pos[0], pos[2], -heading, r, r);
      }
      if (flags.showAttackRadius) this.attack.set(n, pos[0], pos[2], 0, 1, 1);
      if (flags.showZombieState) {
        const rgb = STATE_RGB[zombies.getState(slot)] ?? STATE_RGB[ZombieState.Idle]!;
        this.markers.set(n, pos[0], pos[2], 0, 1, 1);
        this.markers.setColor(n, this.markerColor.setRGB(rgb[0], rgb[1], rgb[2]));
      }
      n += 1;
    });

    this.sight.mesh.visible = flags.showSightRadius;
    if (flags.showSightRadius) this.sight.finalize(n);
    this.attack.mesh.visible = flags.showAttackRadius;
    if (flags.showAttackRadius) this.attack.finalize(n);
    this.markers.mesh.visible = flags.showZombieState;
    if (flags.showZombieState) this.markers.finalize(n);

    this.sound.mesh.visible = flags.showSoundField;
    if (flags.showSoundField) {
      const hits = queryStimuli(player.x, player.z);
      const m = Math.min(hits.length, MAX_SOUND);
      for (let i = 0; i < m; i++) {
        // Ring at the sound's MAXIMUM reach (its emit radius) so you see how WIDE it carries; brightness
        // (instance colour) encodes how HARD it is right now (attenuated intensity). Each sound independent.
        const h = hits[i]!;
        this.sound.set(i, h.x, h.z, 0, h.radius, h.radius);
        const b = 0.25 + 0.75 * Math.min(1, h.intensity);
        this.sound.setColor(i, this.markerColor.setRGB(0.98 * b, 0.8 * b, 0.09 * b));
      }
      this.sound.finalize(m);
    }
  }

  dispose(): void {
    this.sight.dispose();
    this.attack.dispose();
    this.sound.dispose();
    this.markers.dispose();
    this.playerCone.geometry.dispose();
    (this.playerCone.material as MeshBasicNodeMaterial).dispose();
  }
}
